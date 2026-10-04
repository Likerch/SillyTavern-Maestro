// Settings slice of M20 (`extensionSettings.maestro.modules.architect`). Everything that changes the prompt is off
// until the user turns it on in the tab: budgets are 0 (no budget), damping and pinning are off; reports (duplicates,
// cache, P16 order) are on — they only read.
import { BUDGET_SOURCE_IDS, cleanBudgets } from '../../domain/architect-budget';
import type { BudgetSource } from './api';

export const ARCHITECT_KEY = 'architect';
export const ARCHITECT_ID = 'M20';
export const DEFAULT_MENTION_WINDOW = 6;
export const MAX_MENTION_WINDOW = 50;

export const BUDGET_SOURCES: readonly BudgetSource[] = BUDGET_SOURCE_IDS;

export interface ArchitectSettings {
    /** Tokens per source; 0 = no budget. */
    budgets: Record<BudgetSource, number>;
    presence: {
        /** Damp entries about absent characters and far places (plan M20 п. 3). */
        damp: boolean;
        /** Pin entries about present characters and the current place. */
        pin: boolean;
        /** K: a mention in the last K messages keeps an entry. */
        mentionWindow: number;
    };
    duplicates: {
        /** Look for facts repeated across sources after each turn (report only until the user consents). */
        detect: boolean;
    };
    cache: {
        /** Read provider cache numbers from responses and where the prompt first changes. */
        measure: boolean;
        /** Check that Maestro's volatile injections sit after stable content (P16). */
        orderCheck: boolean;
    };
}

export function defaultArchitectSettings(): ArchitectSettings {
    return {
        budgets: cleanBudgets({}),
        presence: { damp: false, pin: false, mentionWindow: DEFAULT_MENTION_WINDOW },
        duplicates: { detect: true },
        cache: { measure: true, orderCheck: true },
    };
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flag(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function cleanWindow(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MENTION_WINDOW;
    return Math.max(1, Math.min(MAX_MENTION_WINDOW, Math.floor(value)));
}

/**
 * The stored slice, repaired in place (a hand-edited or older settings file never breaks the module). Valid values
 * and the nested objects themselves are kept, so it is cheap to call on the send path.
 */
export function readArchitectSettings(slice: Partial<ArchitectSettings>): ArchitectSettings {
    const defaults = defaultArchitectSettings();
    const raw = slice as Record<string, unknown>;
    if (!isDict(raw.budgets)) raw.budgets = cleanBudgets(raw.budgets);
    else {
        const clean = cleanBudgets(raw.budgets);
        for (const source of BUDGET_SOURCES)
            if (raw.budgets[source] !== clean[source]) raw.budgets[source] = clean[source];
    }
    if (!isDict(raw.presence)) raw.presence = { ...defaults.presence };
    const presence = raw.presence as Record<string, unknown>;
    presence.damp = flag(presence.damp, defaults.presence.damp);
    presence.pin = flag(presence.pin, defaults.presence.pin);
    if (presence.mentionWindow !== cleanWindow(presence.mentionWindow)) {
        presence.mentionWindow = cleanWindow(presence.mentionWindow);
    }
    if (!isDict(raw.duplicates)) raw.duplicates = { ...defaults.duplicates };
    const duplicates = raw.duplicates as Record<string, unknown>;
    duplicates.detect = flag(duplicates.detect, defaults.duplicates.detect);
    if (!isDict(raw.cache)) raw.cache = { ...defaults.cache };
    const cache = raw.cache as Record<string, unknown>;
    cache.measure = flag(cache.measure, defaults.cache.measure);
    cache.orderCheck = flag(cache.orderCheck, defaults.cache.orderCheck);
    return slice as ArchitectSettings;
}
