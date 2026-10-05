// A global regex script made by the assistant (M33 «регексы с испытанием»): the script in ST 1.19's shape
// (extensions/regex/engine.js, char-data.js RegexScriptData), checked before anything is written — it must compile
// the way ST compiles it (utils.js regexFromString), it is run on the samples the model gives (the required test,
// shown in the confirmation card), and risky effects are reported: DES tracker JSON, BunnyMo tags, NAI markers
// (the doctor's probes, domain/doctor-regex.ts), World Info placement without «prompt only», empty matches, macros
// the test cannot expand. Pure: no DOM, no SillyTavern.
import { ArgError } from './assistant-write-args';
import {
    compileFind,
    normalizeScript,
    probeBreaksJson,
    probeBreaksMarkers,
    probeStripsTags,
    REGEX_PLACEMENT,
    simulateReplace,
} from './doctor-regex';

/** Where a script acts (ST's `regex_placement`, without the deprecated MD display and the legacy sendAs). */
export const PLACEMENTS = {
    user_input: REGEX_PLACEMENT.USER_INPUT,
    ai_output: REGEX_PLACEMENT.AI_OUTPUT,
    slash_command: REGEX_PLACEMENT.SLASH_COMMAND,
    world_info: REGEX_PLACEMENT.WORLD_INFO,
    reasoning: REGEX_PLACEMENT.REASONING,
} as const;

export type PlacementName = keyof typeof PLACEMENTS;
export const PLACEMENT_NAMES = Object.keys(PLACEMENTS) as PlacementName[];

/**
 * How a script acts: 'display' (markdownOnly: what is shown), 'prompt' (promptOnly: what is sent), both, or 'edit'
 * (neither: the stored message text itself is changed when it arrives or is edited).
 */
export const REGEX_MODES = ['display', 'prompt', 'displayAndPrompt', 'edit'] as const;
export type RegexWriteMode = (typeof REGEX_MODES)[number];

/** Macro substitution in the find pattern (ST's `substitute_find_regex`). */
export const SUBSTITUTE_MODES = { none: 0, raw: 1, escaped: 2 } as const;
export type SubstituteName = keyof typeof SUBSTITUTE_MODES;
export const SUBSTITUTE_NAMES = Object.keys(SUBSTITUTE_MODES) as SubstituteName[];

/**
 * Flags both ST and JavaScript accept: regexFromString checks `[gmixXsuUAJ]` (other letters make it compile the whole
 * `/…/flags` string as a pattern), RegExp knows `dgimsuvy`.
 */
export const REGEX_FLAGS = 'gimsu';

/** A global regex script as ST stores it. */
export interface StRegexScript {
    id: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    trimStrings: string[];
    placement: number[];
    disabled: boolean;
    markdownOnly: boolean;
    promptOnly: boolean;
    runOnEdit: boolean;
    substituteRegex: number;
    minDepth: number | null;
    maxDepth: number | null;
}

export interface RegexDraft {
    name: string;
    find: string;
    replace: string;
    flags?: string;
    placement: readonly PlacementName[];
    mode: RegexWriteMode;
    runOnEdit: boolean;
    trimStrings: readonly string[];
    minDepth: number | null;
    maxDepth: number | null;
    substitute: SubstituteName;
    disabled: boolean;
}

const SLASH_FORM = /^\/([\s\S]+)\/([a-z]*)$/i;

function checkFlags(flags: string): void {
    const unique = new Set(flags);
    if (unique.size !== flags.length || [...flags].some((flag) => !REGEX_FLAGS.includes(flag))) {
        throw new ArgError('regexFlags', { flags });
    }
}

/**
 * The `findRegex` string ST will compile: always the `/pattern/flags` form (a bare pattern would compile without
 * flags, so it would replace only the first match). `find` may already be in that form; `flags` (default 'g' for a
 * bare pattern) must not contradict it.
 */
export function findRegexString(find: string, flags?: string): string {
    const slash = SLASH_FORM.exec(find);
    const pattern = slash ? slash[1]! : find;
    let finalFlags: string;
    if (slash) {
        const own = slash[2] ?? '';
        if (flags !== undefined && [...own].sort().join('') !== [...flags].sort().join('')) {
            throw new ArgError('regexFlagsConflict', { a: own, b: flags });
        }
        finalFlags = own;
    } else {
        finalFlags = flags ?? 'g';
    }
    checkFlags(finalFlags);
    try {
        new RegExp(pattern, finalFlags);
    } catch (error) {
        throw new ArgError('regexCompile', { error: error instanceof Error ? error.message : String(error) });
    }
    const source = `/${pattern}/${finalFlags}`;
    // Belt and braces: the string must come out of ST's own parser the same way.
    const compiled = compileFind(source);
    const direct = new RegExp(pattern, finalFlags);
    if (!compiled || compiled.source !== direct.source || compiled.flags !== direct.flags) {
        throw new ArgError('regexCompile', { error: source });
    }
    return source;
}

function modeFlags(mode: RegexWriteMode): { markdownOnly: boolean; promptOnly: boolean } {
    return {
        markdownOnly: mode === 'display' || mode === 'displayAndPrompt',
        promptOnly: mode === 'prompt' || mode === 'displayAndPrompt',
    };
}

/** The mode of a stored script. */
export function scriptMode(script: Pick<StRegexScript, 'markdownOnly' | 'promptOnly'>): RegexWriteMode {
    if (script.markdownOnly && script.promptOnly) return 'displayAndPrompt';
    if (script.markdownOnly) return 'display';
    if (script.promptOnly) return 'prompt';
    return 'edit';
}

/** Placement names of a stored script (unknown numbers dropped). */
export function placementNames(placement: readonly number[]): PlacementName[] {
    return PLACEMENT_NAMES.filter((name) => placement.includes(PLACEMENTS[name]));
}

/** The script to store (validated); `id` is ST's uuid for it. */
export function buildRegexScript(draft: RegexDraft, id: string): StRegexScript {
    if (!draft.name.trim()) throw new ArgError('argEmpty', { name: 'name' });
    if (!draft.placement.length) throw new ArgError('argMissing', { name: 'placement' });
    if (draft.minDepth !== null && draft.maxDepth !== null && draft.minDepth > draft.maxDepth) {
        throw new ArgError('regexDepth');
    }
    const placement = [...new Set(draft.placement.map((name) => PLACEMENTS[name]))].sort((a, b) => a - b);
    return {
        id,
        scriptName: draft.name.trim(),
        findRegex: findRegexString(draft.find, draft.flags),
        replaceString: draft.replace,
        trimStrings: draft.trimStrings.filter((item) => item.length > 0),
        placement,
        disabled: draft.disabled,
        ...modeFlags(draft.mode),
        runOnEdit: draft.runOnEdit,
        substituteRegex: SUBSTITUTE_MODES[draft.substitute],
        minDepth: draft.minDepth,
        maxDepth: draft.maxDepth,
    };
}

export interface SampleResult {
    input: string;
    output: string;
    changed: boolean;
}

/** Runs the script on each sample the way ST does (without macros: `{{…}}` stay as they are). */
export function runSamples(script: StRegexScript, samples: readonly string[]): SampleResult[] {
    const regex = compileFind(script.findRegex);
    return samples.map((input) => {
        const output = simulateReplace(
            { find: script.findRegex, replace: script.replaceString, trimStrings: script.trimStrings },
            input,
            regex,
        );
        return { input, output, changed: output !== input };
    });
}

export interface ExpectedMismatch {
    /** 1-based sample number. */
    index: number;
    expected: string;
    actual: string;
}

/** Samples whose result differs from what the model expected. */
export function expectedMismatches(results: readonly SampleResult[], expected: readonly string[]): ExpectedMismatch[] {
    if (expected.length !== results.length) throw new ArgError('regexExpectedCount', { count: results.length });
    const mismatches: ExpectedMismatch[] = [];
    results.forEach((result, index) => {
        const want = expected[index]!;
        if (result.output !== want) mismatches.push({ index: index + 1, expected: want, actual: result.output });
    });
    return mismatches;
}

export type RegexWarning =
    'breaksJson' | 'stripsTags' | 'breaksMarkers' | 'worldInfoNotPrompt' | 'matchesEmpty' | 'macros' | 'sameName';

/** What the card should warn about (in this order). `otherNames`: names of the existing global scripts. */
export function regexWarnings(script: StRegexScript, otherNames: readonly string[] = []): RegexWarning[] {
    const warnings: RegexWarning[] = [];
    const regex = compileFind(script.findRegex);
    const info = normalizeScript(script, 'global', 0, true);
    const output = script.placement.includes(REGEX_PLACEMENT.AI_OUTPUT);
    const lore = script.placement.includes(REGEX_PLACEMENT.WORLD_INFO);
    if (regex) {
        if (output && probeBreaksJson(info, regex).broken) warnings.push('breaksJson');
        if ((output || lore) && probeStripsTags(info, regex)) warnings.push('stripsTags');
        if (output && probeBreaksMarkers(info, regex)) warnings.push('breaksMarkers');
        regex.lastIndex = 0;
        const empty = regex.exec('');
        regex.lastIndex = 0;
        if (empty && empty[0] === '') warnings.push('matchesEmpty');
    }
    // world-info.js regexes lore with `isPrompt: true` only.
    if (lore && !script.promptOnly) warnings.push('worldInfoNotPrompt');
    if (script.substituteRegex !== SUBSTITUTE_MODES.none || /\{\{[^}]+\}\}/.test(script.replaceString)) {
        warnings.push('macros');
    }
    const lower = script.scriptName.toLowerCase();
    if (otherNames.some((name) => name.toLowerCase() === lower)) warnings.push('sameName');
    return warnings;
}

/** Locates a script in a list: by ST id, by `global:<id>` / `global:<index>` (the doctor's inventory ids), by name. */
export function locateScript(
    list: readonly { id?: unknown; scriptName?: unknown }[],
    wanted: string,
): { index: number; ambiguous: boolean } {
    const ref = wanted.trim();
    const bare = ref.startsWith('global:') ? ref.slice('global:'.length) : ref;
    const byId = list.findIndex((script) => typeof script.id === 'string' && script.id === bare);
    if (byId >= 0) return { index: byId, ambiguous: false };
    if (ref.startsWith('global:') && /^\d+$/.test(bare)) {
        const index = Number(bare);
        if (index < list.length && !list[index]?.id) return { index, ambiguous: false };
    }
    const lower = bare.toLowerCase();
    const named = list
        .map((script, index) => ({ name: typeof script.scriptName === 'string' ? script.scriptName : '', index }))
        .filter((item) => item.name.toLowerCase() === lower);
    if (named.length === 1) return { index: named[0]!.index, ambiguous: false };
    return { index: -1, ambiguous: named.length > 1 };
}

/** The id belongs to a character card's or a preset's script (the doctor's inventory form). */
export function isForeignScriptRef(wanted: string): boolean {
    return /^(scoped|preset):/.test(wanted.trim());
}

/** The fields the card shows for a script. */
export function scriptView(script: StRegexScript): Record<string, unknown> {
    return {
        name: script.scriptName,
        find: script.findRegex,
        replace: script.replaceString,
        placement: placementNames(script.placement),
        mode: scriptMode(script),
        ...(script.trimStrings.length ? { trimStrings: script.trimStrings } : {}),
        ...(script.minDepth !== null ? { minDepth: script.minDepth } : {}),
        ...(script.maxDepth !== null ? { maxDepth: script.maxDepth } : {}),
        ...(script.disabled ? { disabled: true } : {}),
    };
}
