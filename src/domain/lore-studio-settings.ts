// Global World Info settings of ST 1.19 as the Lore Studio edits them (research/parity-lore.md §5, L-129…L-141):
// ranges and defaults, the classic panel's element and the DOM event its handler listens to, which ones make ST
// emit WORLDINFO_SETTINGS_UPDATED, and the mutual exclusion «min activations ↔ max recursion steps». Pure.

export type WiSettingKind = 'number' | 'boolean' | 'select';

export interface WiSettingSpec {
    key: string;
    kind: WiSettingKind;
    min?: number;
    max?: number;
    defaultValue: number | boolean;
    /** Element of the classic panel whose handler applies the value (`#world_info_depth`, …). */
    element: string;
    /** Event ST listens to on that element (initWorldInfo, WI:6231-6313). */
    event: 'input' | 'change';
    /** ST emits WORLDINFO_SETTINGS_UPDATED after this one (Group Scoring and Overflow Alert only save). */
    emits: boolean;
    /** Select options (values). */
    options?: readonly number[];
    labelKey: string;
    hintKey: string;
}

export const WI_SETTINGS: readonly WiSettingSpec[] = [
    {
        key: 'world_info_depth',
        kind: 'number',
        min: 0,
        max: 1000,
        defaultValue: 2,
        element: 'world_info_depth',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.depth',
        hintKey: 'm23.wi.depthHint',
    },
    {
        key: 'world_info_budget',
        kind: 'number',
        min: 1,
        max: 100,
        defaultValue: 25,
        element: 'world_info_budget',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.budget',
        hintKey: 'm23.wi.budgetHint',
    },
    {
        key: 'world_info_budget_cap',
        kind: 'number',
        min: 0,
        max: 65536,
        defaultValue: 0,
        element: 'world_info_budget_cap',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.budgetCap',
        hintKey: 'm23.wi.budgetCapHint',
    },
    {
        key: 'world_info_min_activations',
        kind: 'number',
        min: 0,
        max: 100,
        defaultValue: 0,
        element: 'world_info_min_activations',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.minActivations',
        hintKey: 'm23.wi.minActivationsHint',
    },
    {
        key: 'world_info_min_activations_depth_max',
        kind: 'number',
        min: 0,
        max: 100,
        defaultValue: 0,
        element: 'world_info_min_activations_depth_max',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.minActivationsDepth',
        hintKey: 'm23.wi.minActivationsDepthHint',
    },
    {
        key: 'world_info_max_recursion_steps',
        kind: 'number',
        min: 0,
        max: 10,
        defaultValue: 0,
        element: 'world_info_max_recursion_steps',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.maxRecursion',
        hintKey: 'm23.wi.maxRecursionHint',
    },
    {
        key: 'world_info_character_strategy',
        kind: 'select',
        defaultValue: 1,
        options: [0, 1, 2],
        element: 'world_info_character_strategy',
        event: 'change',
        emits: true,
        labelKey: 'm23.wi.strategy',
        hintKey: 'm23.wi.strategyHint',
    },
    {
        key: 'world_info_include_names',
        kind: 'boolean',
        defaultValue: true,
        element: 'world_info_include_names',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.includeNames',
        hintKey: 'm23.wi.includeNamesHint',
    },
    {
        key: 'world_info_recursive',
        kind: 'boolean',
        defaultValue: false,
        element: 'world_info_recursive',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.recursive',
        hintKey: 'm23.wi.recursiveHint',
    },
    {
        key: 'world_info_case_sensitive',
        kind: 'boolean',
        defaultValue: false,
        element: 'world_info_case_sensitive',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.caseSensitive',
        hintKey: 'm23.wi.caseSensitiveHint',
    },
    {
        key: 'world_info_match_whole_words',
        kind: 'boolean',
        defaultValue: false,
        element: 'world_info_match_whole_words',
        event: 'input',
        emits: true,
        labelKey: 'm23.wi.wholeWords',
        hintKey: 'm23.wi.wholeWordsHint',
    },
    {
        key: 'world_info_use_group_scoring',
        kind: 'boolean',
        defaultValue: false,
        element: 'world_info_use_group_scoring',
        event: 'change',
        emits: false,
        labelKey: 'm23.wi.groupScoring',
        hintKey: 'm23.wi.groupScoringHint',
    },
    {
        key: 'world_info_overflow_alert',
        kind: 'boolean',
        defaultValue: false,
        element: 'world_info_overflow_alert',
        event: 'change',
        emits: false,
        labelKey: 'm23.wi.overflowAlert',
        hintKey: 'm23.wi.overflowAlertHint',
    },
];

export type WiSettingsValues = Record<string, number | boolean>;

export function settingSpec(key: string): WiSettingSpec | undefined {
    return WI_SETTINGS.find((spec) => spec.key === key);
}

/** A value coerced like ST does (`Number(...)`, `Boolean(...)`) and clamped to the control's range. */
export function coerceSetting(spec: WiSettingSpec, value: unknown): number | boolean {
    if (spec.kind === 'boolean') return typeof value === 'string' ? value === 'true' : Boolean(value);
    let number = Number(value);
    if (!Number.isFinite(number)) number = Number(spec.defaultValue);
    if (spec.kind === 'select') {
        return spec.options?.includes(number) ? number : Number(spec.defaultValue);
    }
    number = Math.round(number);
    if (spec.min !== undefined) number = Math.max(spec.min, number);
    if (spec.max !== undefined) number = Math.min(spec.max, number);
    return number;
}

/** Current values from ST's `getWorldInfoSettings()` (missing ones take ST's defaults). */
export function readWiSettings(source: Record<string, unknown> | null | undefined): WiSettingsValues {
    const values: WiSettingsValues = {};
    for (const spec of WI_SETTINGS) {
        const raw = source?.[spec.key];
        values[spec.key] = raw === undefined || raw === null ? spec.defaultValue : coerceSetting(spec, raw);
    }
    return values;
}

const MIN_ACTIVATIONS = 'world_info_min_activations';
const MAX_RECURSION = 'world_info_max_recursion_steps';

/**
 * Normalizes a patch: unknown keys dropped, values coerced and clamped, and the mutual exclusion applied in
 * patch order (a non-zero «min activations» zeroes «max recursion steps» and vice versa, WI:6237-6248, 6303-6313).
 * Returns only the keys whose value changes.
 */
export function normalizeWiPatch(current: WiSettingsValues, patch: Record<string, unknown>): WiSettingsValues {
    const next: WiSettingsValues = { ...current };
    for (const [key, raw] of Object.entries(patch)) {
        const spec = settingSpec(key);
        if (!spec) continue;
        const value = coerceSetting(spec, raw);
        next[key] = value;
        if (key === MIN_ACTIVATIONS && value !== 0 && next[MAX_RECURSION] !== 0) next[MAX_RECURSION] = 0;
        if (key === MAX_RECURSION && value !== 0 && next[MIN_ACTIVATIONS] !== 0) next[MIN_ACTIVATIONS] = 0;
    }
    const changed: WiSettingsValues = {};
    for (const spec of WI_SETTINGS) {
        const value = next[spec.key];
        if (value !== undefined && value !== current[spec.key]) changed[spec.key] = value;
    }
    return changed;
}

/** True when any key of a patch makes ST emit WORLDINFO_SETTINGS_UPDATED. */
export function patchEmits(patch: WiSettingsValues): boolean {
    return Object.keys(patch).some((key) => settingSpec(key)?.emits === true);
}
