// Settings slice of M12 (`extensionSettings.maestro.modules.quality`): action per defect kind (plan M12 table, §8),
// the AI judge switch, the early cutoff switch and the content boundary rules (§11: configurable, filled by default).
import { DEFAULT_BOUNDARY_RULES } from '../../domain/quality-checks';
import { DEFAULT_ACTIONS } from '../../domain/quality-types';
import type { BoundaryRule, DefectAction, DefectKind } from './api';

export const QUALITY_KEY = 'quality';
export const QUALITY_ID = 'M12';

/** Every defect kind in the order the pult lists them. */
export const DEFECT_KINDS: readonly DefectKind[] = [
    'junk',
    'truncated',
    'missingTracker',
    'language',
    'userSpeech',
    'refusal',
    'moralizing',
    'softening',
    'boundary',
    'repetition',
    'canonContradiction',
];

const ACTIONS: readonly DefectAction[] = ['off', 'auto', 'notify'];

export interface QualitySettings {
    /** Module default per kind; the user's choice (and an accepted trust offer) lives in core autonomy 'quality.<kind>'. */
    actions: Record<DefectKind, DefectAction>;
    /** Ask the cheap model when a rule is not sure (never in «Экономный»). */
    judge: boolean;
    /** Stop the stream on a known junk token and swipe once (counts toward the one auto-swipe per turn). */
    earlyCutoff: boolean;
    /** Content boundary (§11). */
    boundary: BoundaryRule[];
}

export function copyRules(rules: readonly BoundaryRule[]): BoundaryRule[] {
    return rules.map((rule) => ({ ...rule, patterns: [...rule.patterns] }));
}

export function defaultQualitySettings(): QualitySettings {
    return {
        actions: { ...DEFAULT_ACTIONS },
        judge: true,
        earlyCutoff: true,
        boundary: copyRules(DEFAULT_BOUNDARY_RULES),
    };
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A rule from stored or edited data; null for junk. Patterns are trimmed, empty ones dropped. */
export function readRule(value: unknown): BoundaryRule | null {
    if (!isDict(value) || typeof value.id !== 'string' || !value.id.trim()) return null;
    const patterns = Array.isArray(value.patterns)
        ? value.patterns.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
        : [];
    return {
        id: value.id.trim(),
        title: typeof value.title === 'string' ? value.title : '',
        patterns: patterns.filter(Boolean),
        enabled: value.enabled !== false,
    };
}

function sameRule(rule: BoundaryRule, stored: unknown): boolean {
    if (!isDict(stored) || !Array.isArray(stored.patterns)) return false;
    return (
        stored.id === rule.id &&
        stored.title === rule.title &&
        stored.enabled === rule.enabled &&
        stored.patterns.length === rule.patterns.length &&
        stored.patterns.every((pattern, i) => pattern === rule.patterns[i])
    );
}

/** The live slice, repaired in place (it is the object the pult edits). */
export function readQualitySettings(slice: Partial<QualitySettings>): QualitySettings {
    if (!isDict(slice.actions)) slice.actions = { ...DEFAULT_ACTIONS };
    const actions = slice.actions as Record<string, unknown>;
    for (const kind of DEFECT_KINDS) {
        if (!ACTIONS.includes(actions[kind] as DefectAction)) actions[kind] = DEFAULT_ACTIONS[kind];
    }
    if (typeof slice.judge !== 'boolean') slice.judge = true;
    if (typeof slice.earlyCutoff !== 'boolean') slice.earlyCutoff = true;
    if (!Array.isArray(slice.boundary)) {
        slice.boundary = copyRules(DEFAULT_BOUNDARY_RULES);
    } else {
        const stored = slice.boundary as unknown[];
        const rules = stored.map(readRule).filter((rule): rule is BoundaryRule => rule !== null);
        const same = rules.length === stored.length && rules.every((rule, i) => sameRule(rule, stored[i]));
        if (!same) slice.boundary = rules;
    }
    return slice as QualitySettings;
}

/**
 * Checks a pattern of a boundary rule: a regex source (flags 'iu'), a plain word, or `both:<A>&&<B>` (both parts
 * must hit the same reply). Returns the bad part, or null when the pattern compiles.
 */
export function patternError(pattern: string): string | null {
    const parts = pattern.startsWith('both:') ? pattern.slice(5).split('&&') : [pattern];
    if (parts.some((part) => !part.trim())) return pattern;
    for (const part of parts) {
        try {
            new RegExp(part.trim(), 'iu');
        } catch {
            return part;
        }
    }
    return null;
}
