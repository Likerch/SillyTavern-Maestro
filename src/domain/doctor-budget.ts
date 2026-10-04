// Global World Info settings review (plan M5 п. 7; research/st-world-info.md §4) and the numbers the wizard
// suggests: book caps (M20 п. 2, rule `book.cap`) and the cost of parsing an old chat's history (plan §7).
import { DOCTOR_RULES } from './doctor-types';
import type { DoctorEntry, DoctorIssue } from './doctor-types';

export type InsertionStrategy = 'evenly' | 'characterFirst' | 'globalFirst';

export interface WiGlobalSettings {
    /** Scan depth in messages. */
    depth: number;
    /** Budget, percent of the context. */
    budgetPercent: number;
    /** Budget cap in tokens; 0 = none. */
    budgetCap: number;
    recursive: boolean;
    /** 0 = unlimited; counts the initial scan. */
    maxRecursionSteps: number;
    minActivations: number;
    caseSensitive: boolean;
    wholeWords: boolean;
    strategy: InsertionStrategy;
    overflowAlert: boolean;
}

const STRATEGIES: readonly InsertionStrategy[] = ['evenly', 'characterFirst', 'globalFirst'];

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Reads world-info.js settings: the object of `getWorldInfoSettings()` or the module namespace itself (both carry
 * the `world_info_*` names). Missing values take ST's defaults.
 */
export function readWiSettings(raw: Record<string, unknown>): WiGlobalSettings {
    const strategy = num(raw.world_info_character_strategy, 1);
    return {
        depth: num(raw.world_info_depth, 2),
        budgetPercent: num(raw.world_info_budget, 25),
        budgetCap: num(raw.world_info_budget_cap, 0),
        recursive: raw.world_info_recursive === true,
        maxRecursionSteps: num(raw.world_info_max_recursion_steps, 0),
        minActivations: num(raw.world_info_min_activations, 0),
        caseSensitive: raw.world_info_case_sensitive === true,
        wholeWords: raw.world_info_match_whole_words === true,
        strategy: STRATEGIES[strategy] ?? 'characterFirst',
        overflowAlert: raw.world_info_overflow_alert === true,
    };
}

/** ST's budget: `round(percent × context / 100) || 1`, capped by the budget cap (world-info.js). Null without a context. */
export function budgetTokens(settings: WiGlobalSettings, maxContext: number | null): number | null {
    if (!maxContext || maxContext <= 0) return null;
    let budget = Math.round((settings.budgetPercent * maxContext) / 100) || 1;
    if (settings.budgetCap > 0) budget = Math.min(budget, settings.budgetCap);
    return budget;
}

/** Rough tokens of English lore text (≈ 4 characters per token). */
export function charsToTokens(chars: number, charsPerToken = 4): number {
    return Math.max(0, Math.round(chars / charsPerToken));
}

/** A budget this large never limits anything in practice. */
export const UNLIMITED_BUDGET_TOKENS = 50_000;

export interface LoreTurnsSummary {
    /** Turns looked at. */
    turns: number;
    /** Turns whose lore hit the budget. */
    overflowTurns: number;
    /** Activations cut by the budget over those turns. */
    cut: number;
}

export interface BudgetInput {
    settings: WiGlobalSettings;
    maxContext: number | null;
    entries: readonly DoctorEntry[];
    journal?: LoreTurnsSummary;
}

/** Budget size, constants over budget, real overflows (M1), entries outside the budget, the insertion strategy. */
export function findBudgetIssues(input: BudgetInput): DoctorIssue[] {
    const { settings } = input;
    const issues: DoctorIssue[] = [];
    const budget = budgetTokens(settings, input.maxContext);
    const enabled = input.entries.filter((entry) => !entry.disable);
    const constantTokens = charsToTokens(
        enabled.filter((entry) => entry.constant).reduce((sum, entry) => sum + entry.content.length, 0),
    );
    const target = { setting: 'world_info_budget' };
    let binding = false;

    if (budget !== null && settings.budgetCap === 0 && budget >= UNLIMITED_BUDGET_TOKENS) {
        issues.push({
            kind: 'budget.overflow',
            severity: 'warn',
            messageKey: 'm5.f.budgetUnlimited',
            params: { percent: settings.budgetPercent, context: input.maxContext ?? 0, budget },
            target,
            fixRule: DOCTOR_RULES.bookCap,
        });
    }
    if (budget !== null && constantTokens > budget) {
        binding = true;
        issues.push({
            kind: 'budget.overflow',
            severity: 'warn',
            messageKey: 'm5.f.budgetConstants',
            params: { constants: constantTokens, budget },
            target,
        });
    }
    const journal = input.journal;
    if (journal && journal.overflowTurns > 0) {
        binding = true;
        issues.push({
            kind: 'budget.overflow',
            severity: 'warn',
            messageKey: settings.overflowAlert ? 'm5.f.budgetOverflowed' : 'm5.f.budgetOverflowedSilent',
            params: { count: journal.overflowTurns, turns: journal.turns, cut: journal.cut },
            target,
            fixRule: DOCTOR_RULES.bookCap,
        });
    }
    const ignored = enabled.filter((entry) => entry.ignoreBudget);
    if (ignored.length) {
        issues.push({
            kind: 'budget.strategy',
            severity: 'info',
            messageKey: 'm5.f.budgetIgnored',
            params: { count: ignored.length, chars: ignored.reduce((sum, entry) => sum + entry.content.length, 0) },
            target: { setting: 'ignoreBudget' },
        });
    }
    if (binding) {
        issues.push({
            kind: 'budget.strategy',
            severity: 'info',
            messageKey: `m5.f.budgetStrategy.${settings.strategy}`,
            params: { budget: budget ?? 0 },
            target: { setting: 'world_info_character_strategy' },
        });
    }
    return issues;
}

/* ------------------------------------------------------------------ wizard numbers */

export interface CapSuggestion {
    book: string;
    /** Characters the book sends now (per turn from M1, or the static size). */
    currentChars: number;
    currentTokens: number;
    /** Suggested cap in tokens (editable in the wizard). */
    capTokens: number;
}

export interface CapOptions {
    /** Share of the current size to keep (plan: 30–40 %). */
    share?: number;
    /** Books below this size need no cap. */
    minChars?: number;
    /** How many of the heaviest books to suggest. */
    limit?: number;
}

/** Cap for one book: `share` of its current size in tokens, rounded to 500, at least 1000. */
export function suggestCapTokens(chars: number, share = 0.35): number {
    const tokens = charsToTokens(chars * share);
    return Math.max(1000, Math.round(tokens / 500) * 500);
}

/** Caps for the heaviest books (sorted by size, largest first). */
export function suggestBookCaps(
    rows: readonly { book: string; chars: number }[],
    options: CapOptions = {},
): CapSuggestion[] {
    const share = options.share ?? 0.35;
    const minChars = options.minChars ?? 20_000;
    const limit = options.limit ?? 3;
    return [...rows]
        .filter((row) => row.chars >= minChars)
        .sort((a, b) => b.chars - a.chars)
        .slice(0, limit)
        .map((row) => ({
            book: row.book,
            currentChars: row.chars,
            currentTokens: charsToTokens(row.chars),
            capTokens: suggestCapTokens(row.chars, share),
        }));
}

/** Tokens of chat history to parse (Russian text: ≈ 3.5 characters per token). */
export function historyTokens(chars: number): number {
    return charsToTokens(chars, 3.5);
}

/**
 * A rough price of parsing history on a cheap background model. Input and output are blended at
 * `usdPerMillion` (default $0.5 per million tokens, DeepSeek V4 Flash class); the real price depends on the profile.
 */
export function bootstrapCostUsd(tokens: number, usdPerMillion = 0.5): number {
    return (tokens / 1_000_000) * usdPerMillion;
}
