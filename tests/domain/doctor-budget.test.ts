import { describe, expect, it } from 'vitest';
import {
    bootstrapCostUsd,
    budgetTokens,
    charsToTokens,
    findBudgetIssues,
    historyTokens,
    readWiSettings,
    suggestBookCaps,
    suggestCapTokens,
} from '../../src/domain/doctor-budget';
import { entry } from '../helpers/doctor-entries';

describe('readWiSettings', () => {
    it('reads world-info.js names with ST defaults', () => {
        expect(readWiSettings({})).toEqual({
            depth: 2,
            budgetPercent: 25,
            budgetCap: 0,
            recursive: false,
            maxRecursionSteps: 0,
            minActivations: 0,
            caseSensitive: false,
            wholeWords: false,
            strategy: 'characterFirst',
            overflowAlert: false,
        });
        const settings = readWiSettings({
            world_info_depth: 4,
            world_info_budget: 10,
            world_info_budget_cap: 8000,
            world_info_recursive: true,
            world_info_max_recursion_steps: 3,
            world_info_min_activations: 2,
            world_info_case_sensitive: true,
            world_info_match_whole_words: true,
            world_info_character_strategy: 0,
            world_info_overflow_alert: true,
        });
        expect(settings).toMatchObject({ depth: 4, budgetCap: 8000, strategy: 'evenly', overflowAlert: true });
        expect(readWiSettings({ world_info_character_strategy: 2 }).strategy).toBe('globalFirst');
        expect(readWiSettings({ world_info_character_strategy: 9, world_info_budget: NaN }).strategy).toBe(
            'characterFirst',
        );
    });

    it('computes the budget like ST', () => {
        const settings = readWiSettings({ world_info_budget: 25 });
        expect(budgetTokens(settings, null)).toBeNull();
        expect(budgetTokens(settings, 1_000_000)).toBe(250_000);
        expect(budgetTokens({ ...settings, budgetCap: 9000 }, 1_000_000)).toBe(9000);
        expect(budgetTokens({ ...settings, budgetPercent: 0 }, 100)).toBe(1);
        expect(charsToTokens(10)).toBe(3);
        expect(charsToTokens(-5)).toBe(0);
    });
});

describe('findBudgetIssues', () => {
    const settings = readWiSettings({ world_info_budget: 25 });

    it('warns about an effectively unlimited budget and notes entries outside it', () => {
        const issues = findBudgetIssues({
            settings,
            maxContext: 1_000_000,
            entries: [
                entry('A', { ignoreBudget: true, content: 'x'.repeat(40) }),
                entry('A', { ignoreBudget: true, disable: true }),
            ],
        });
        expect(issues.map((issue) => issue.messageKey)).toEqual(['m5.f.budgetUnlimited', 'm5.f.budgetIgnored']);
        expect(issues[0]).toMatchObject({
            params: { percent: 25, context: 1_000_000, budget: 250_000 },
            fixRule: 'book.cap',
        });
        expect(issues[1]?.params).toEqual({ count: 1, chars: 40 });
    });

    it('reports constants over the budget, real overflows and the strategy that cuts', () => {
        const issues = findBudgetIssues({
            settings: { ...settings, overflowAlert: false },
            maxContext: 1000,
            entries: [entry('A', { constant: true, content: 'x'.repeat(2000) })],
            journal: { turns: 20, overflowTurns: 3, cut: 12 },
        });
        expect(issues.map((issue) => issue.messageKey)).toEqual([
            'm5.f.budgetConstants',
            'm5.f.budgetOverflowedSilent',
            'm5.f.budgetStrategy.characterFirst',
        ]);
        expect(issues[0]?.params).toEqual({ constants: 500, budget: 250 });
        const alert = findBudgetIssues({
            settings: { ...settings, overflowAlert: true },
            maxContext: null,
            entries: [],
            journal: { turns: 5, overflowTurns: 1, cut: 2 },
        });
        expect(alert.map((issue) => issue.messageKey)).toEqual([
            'm5.f.budgetOverflowed',
            'm5.f.budgetStrategy.characterFirst',
        ]);
        expect(
            findBudgetIssues({
                settings,
                maxContext: 8000,
                entries: [],
                journal: { turns: 5, overflowTurns: 0, cut: 0 },
            }),
        ).toEqual([]);
    });
});

describe('wizard numbers', () => {
    it('suggests caps for the heaviest books only', () => {
        expect(suggestCapTokens(134_000)).toBe(11_500);
        expect(suggestCapTokens(1000)).toBe(1000);
        const caps = suggestBookCaps(
            [
                { book: 'Small', chars: 5000 },
                { book: 'Flora', chars: 134_000 },
                { book: 'Species', chars: 45_000 },
                { book: 'Mid', chars: 30_000 },
                { book: 'Other', chars: 25_000 },
            ],
            { limit: 2 },
        );
        expect(caps).toEqual([
            { book: 'Flora', currentChars: 134_000, currentTokens: 33_500, capTokens: 11_500 },
            { book: 'Species', currentChars: 45_000, currentTokens: 11_250, capTokens: 4000 },
        ]);
        expect(suggestBookCaps([{ book: 'A', chars: 30_000 }], { share: 0.5, minChars: 40_000 })).toEqual([]);
    });

    it('estimates the cost of parsing history', () => {
        expect(historyTokens(3500)).toBe(1000);
        expect(bootstrapCostUsd(2_000_000)).toBe(1);
        expect(bootstrapCostUsd(1_000_000, 0.3)).toBeCloseTo(0.3);
    });
});
