import { describe, expect, it } from 'vitest';
import {
    BUDGET_SOURCE_IDS,
    MAX_BUDGET_TOKENS,
    budgetShare,
    cleanBudget,
    cleanBudgets,
    planLoreBudget,
} from '../../src/domain/architect-budget';
import type { LoreBudgetItem } from '../../src/domain/architect-budget';

function item(key: string, fields: Partial<LoreBudgetItem> = {}): LoreBudgetItem {
    return { key, tokens: 100, order: 100, priority: 0, exempt: false, constant: false, ...fields };
}

describe('budget settings', () => {
    it('cleans single values', () => {
        expect(cleanBudget(1500.7)).toBe(1500);
        expect(cleanBudget(-3)).toBe(0);
        expect(cleanBudget('100')).toBe(0);
        expect(cleanBudget(Number.POSITIVE_INFINITY)).toBe(0);
        expect(cleanBudget(5e9)).toBe(MAX_BUDGET_TOKENS);
    });

    it('fills every source', () => {
        const budgets = cleanBudgets({ lore: 2000, qvink: 'x', extra: 5 });
        expect(Object.keys(budgets)).toEqual([...BUDGET_SOURCE_IDS]);
        expect(budgets.lore).toBe(2000);
        expect(budgets.qvink).toBe(0);
        expect(cleanBudgets(null).director).toBe(0);
        expect(cleanBudgets([1, 2]).lore).toBe(0);
    });

    it('computes the used share', () => {
        expect(budgetShare(50, 100)).toBe(0.5);
        expect(budgetShare(50, 0)).toBe(0);
        expect(budgetShare(0, 100)).toBe(0);
    });
});

describe('planLoreBudget', () => {
    it('cuts nothing without a budget or when everything fits', () => {
        const items = [item('a.1'), item('a.2')];
        expect(planLoreBudget(items, 0)).toEqual({ cut: [], used: 200, cutTokens: 0 });
        expect(planLoreBudget(items, 200)).toEqual({ cut: [], used: 200, cutTokens: 0 });
    });

    it('cuts the lowest order first and stops as soon as the total fits', () => {
        const items = [item('a.1', { order: 300 }), item('a.2', { order: 50 }), item('a.3', { order: 100 })];
        const plan = planLoreBudget(items, 150);
        expect(plan.cut).toEqual(['a.2', 'a.3']);
        expect(plan.used).toBe(100);
        expect(plan.cutTokens).toBe(200);
        expect(planLoreBudget(items, 250).cut).toEqual(['a.2']);
    });

    it('never cuts exempt entries (pinned, canon, present), though they count', () => {
        const items = [
            item('pin.1', { order: 1, exempt: true, tokens: 400 }),
            item('a.2', { order: 200 }),
            item('a.3', { order: 300 }),
        ];
        const plan = planLoreBudget(items, 450);
        expect(plan.cut).toEqual(['a.2', 'a.3']);
        expect(plan.used).toBe(400);
    });

    it('cuts constants last and, at equal order, the one ST ranks lower', () => {
        const items = [
            item('c.1', { order: 1, constant: true }),
            item('a.2', { order: 100, priority: 1 }),
            item('a.3', { order: 100, priority: 7 }),
            item('a.4', { order: 100, priority: 7 }),
        ];
        expect(planLoreBudget(items, 300).cut).toEqual(['a.3']);
        expect(planLoreBudget(items, 100).cut).toEqual(['a.3', 'a.4', 'a.2']);
        expect(planLoreBudget(items, 0.5).cut).toEqual(['a.3', 'a.4', 'a.2', 'c.1']);
        expect(planLoreBudget([item('b.1'), item('a.1')], 100).cut).toEqual(['a.1']);
    });

    it('treats negative token counts as zero', () => {
        expect(planLoreBudget([item('a.1', { tokens: -5 }), item('a.2')], 50).used).toBe(0);
    });
});
