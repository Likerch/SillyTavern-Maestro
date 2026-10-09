// M20 «Архитектор промпта», pure budget logic (plan M20 п. 1): which lore activations leave the prompt when the
// total lore of one scan is over the lore budget, and the shape of the budget settings. Book caps and recursion
// limits stay M22's rule 'book.cap' (п. 2); this budget runs after them, over every book at once.
// Pure: no DOM, no SillyTavern.

export const BUDGET_SOURCE_IDS = [
    'lore',
    'ckRag',
    'qvink',
    'des',
    'voices',
    'mechanics',
    'director',
    'dramatis',
] as const;
export type BudgetSourceId = (typeof BUDGET_SOURCE_IDS)[number];

/** Upper bound of one budget (tokens): anything larger is a typo. */
export const MAX_BUDGET_TOKENS = 1_000_000;

/** A budget value as stored: a whole number of tokens ≥ 0 (0 = no budget); anything else → 0. */
export function cleanBudget(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
    return Math.min(MAX_BUDGET_TOKENS, Math.floor(value));
}

/** Every source with a clean value (missing and broken ones → 0). */
export function cleanBudgets(raw: unknown): Record<BudgetSourceId, number> {
    const source =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const result = {} as Record<BudgetSourceId, number>;
    for (const id of BUDGET_SOURCE_IDS) result[id] = cleanBudget(source[id]);
    return result;
}

export interface LoreBudgetItem {
    /** `world.uid`, the key of ST's `activated.entries`. */
    key: string;
    tokens: number;
    order: number;
    /** Position in ST's sorted entries (lower = ST's higher priority). */
    priority: number;
    /** Never cut: pinned by Maestro or the canon, canon activations, entries of present characters and the current
     * place, `ignoreBudget`, BunnyMo core. Exempt entries still count toward the total. */
    exempt: boolean;
    /** Constant entries go last among the cuttable ones. */
    constant: boolean;
}

export interface LoreBudgetPlan {
    cut: string[];
    /** Tokens left after the cuts. */
    used: number;
    cutTokens: number;
}

/**
 * Cuts lore over the budget: non-exempt activations, non-constant before constant, lowest `order` first, then the
 * ones ST ranks lower; it stops as soon as the total fits. With limit 0 nothing is cut.
 */
export function planLoreBudget(items: readonly LoreBudgetItem[], limit: number): LoreBudgetPlan {
    let total = items.reduce((sum, item) => sum + Math.max(0, item.tokens), 0);
    if (!(limit > 0) || total <= limit) return { cut: [], used: total, cutTokens: 0 };
    const candidates = items
        .filter((item) => !item.exempt)
        .sort(
            (a, b) =>
                Number(a.constant) - Number(b.constant) ||
                a.order - b.order ||
                b.priority - a.priority ||
                (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
        );
    const cut: string[] = [];
    let cutTokens = 0;
    for (const item of candidates) {
        if (total <= limit) break;
        const tokens = Math.max(0, item.tokens);
        cut.push(item.key);
        cutTokens += tokens;
        total -= tokens;
    }
    return { cut, used: total, cutTokens };
}

/** Share of a budget used, 0..1+ (0 when there is no budget). */
export function budgetShare(used: number, limit: number): number {
    return limit > 0 && used > 0 ? used / limit : 0;
}
