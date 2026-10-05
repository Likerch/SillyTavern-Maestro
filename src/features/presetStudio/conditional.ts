// Conditional preset blocks of the Preset Studio (M34 п.8, stage 8; M13 п.2): a block's whole text sits inside
// `{{if .maestro_<flag>}}…{{/if}}` and Maestro sets the flag for one generation (core/ephemeral.ts), so the preset is
// never rewritten per turn and, with Maestro off, the flags are gone and the blocks stay silent (P8, P11). Only the
// new macro engine knows `{{if}}` (`power_user.experimental_macro_engine`, P-133); with the old one the tags and
// every branch reach the model literally. Syntax facts and checks: domain/preset-conditional-syntax.ts and
// domain/preset-conditional-check.ts.
// Here: the flag catalogue (the director's, read at run time from app.modules.api('director') — never imported,
// with fallbacks until it exists), the macro engine state, the rows of the «Условные блоки» tab with a flag
// simulator, findings for «Анализ», and «Подготовить к отключению» for conditional blocks (plan §4.9).
import {
    conditionalInfo,
    mergeCatalogue,
    readFlagEntries,
    validateConditional,
    withoutMaestroConditionals,
} from '../../domain/preset-conditional-check';
import type {
    ConditionalBlockInfo,
    ConditionalIssue,
    ConditionalIssueCode,
    FlagEntry,
} from '../../domain/preset-conditional-check';
import {
    blockCondition,
    evaluate,
    isFlagName,
    isTruthy,
    parseConditional,
    variableText,
} from '../../domain/preset-conditional-syntax';
import type { BlockCondition } from '../../domain/preset-conditional-syntax';
import { isInChat, isMarker, promptName, promptText } from '../../domain/preset-ui-blocks';
import type { App } from '../../shared/contracts';
import type { PresetLayerApi } from './layer-api';
import type { PresetBody, PresetPrompt, PresetStore } from './store-api';

/** Key of the director's API (M13/M14, features/director/api.ts). */
export const DIRECTOR_API_KEY = 'director';
export const MECHANICS_API_KEY = 'mechanics';

/** Scene types of the director (features/director/api.ts SceneType), for the fallback catalogue. */
const SCENE_TYPES = ['dialogue', 'combat', 'intimate', 'exploration', 'timeskip', 'social', 'drama'] as const;

/**
 * The flags the director announces (M13 п.2: `maestro_scene_<type>`; M34 п.8: explicit scene, language) until its
 * own catalogue is exposed; its entries win over these.
 */
export const FALLBACK_FLAGS: readonly FlagEntry[] = [
    ...SCENE_TYPES.map((type): FlagEntry => ({
        name: `maestro_scene_${type}`,
        titleKey: `m34.cond.flag.scene_${type}`,
        source: 'builtin',
    })),
    { name: 'maestro_explicit', titleKey: 'm34.cond.flag.explicit', source: 'builtin' },
    { name: 'maestro_lang_ru', titleKey: 'm34.cond.flag.lang_ru', source: 'builtin' },
];

/** Property names under which the director may expose its catalogue (an array, or a function returning one). */
const CATALOGUE_KEYS = ['catalogue', 'flagCatalogue', 'DIRECTOR_FLAGS', 'directorFlags'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function call(owner: Record<string, unknown>, value: unknown): unknown {
    if (typeof value !== 'function') return value;
    try {
        return (value as () => unknown).call(owner);
    } catch {
        return undefined;
    }
}

/**
 * The director's flag catalogue (`{ name, titleKey, descriptionKey }[]`), read defensively: a `catalogue` /
 * `flagCatalogue` / `DIRECTOR_FLAGS` member (array or function), or `flags()` when it returns an array. Empty when
 * the director is off or exposes none.
 */
export function directorCatalogue(app: App): FlagEntry[] {
    const api = app.modules.api<unknown>(DIRECTOR_API_KEY);
    if (!isRecord(api)) return [];
    for (const key of CATALOGUE_KEYS) {
        const value = call(api, api[key]);
        if (Array.isArray(value)) {
            const entries = readFlagEntries(value, 'director');
            if (entries.length) return entries;
        }
    }
    const flags = call(api, api.flags);
    return Array.isArray(flags) ? readFlagEntries(flags, 'director') : [];
}

/** The mechanics' flags (`flagCatalogue(): { flag, label }[]`, M25): one per mechanic, titled by its name. */
export function mechanicsCatalogue(app: App): FlagEntry[] {
    const api = app.modules.api<unknown>(MECHANICS_API_KEY);
    if (!isRecord(api)) return [];
    const list = call(api, api.flagCatalogue);
    if (!Array.isArray(list)) return [];
    return list.flatMap((item): FlagEntry[] => {
        if (!isRecord(item) || typeof item.flag !== 'string' || !isFlagName(item.flag)) return [];
        const entry: FlagEntry = {
            name: item.flag,
            source: 'mechanics',
            titleKey: 'm25.prompt.flag',
            descriptionKey: 'm25.prompt.flag.hint',
        };
        if (typeof item.label === 'string' && item.label) entry.label = item.label;
        return [entry];
    });
}

/** The mechanics' flags that are on now (`flagsOn(): string[]`). */
export function mechanicsFlagsOn(app: App): string[] {
    const api = app.modules.api<unknown>(MECHANICS_API_KEY);
    if (!isRecord(api)) return [];
    const flags = call(api, api.flagsOn);
    return Array.isArray(flags) ? flags.filter((name): name is string => typeof name === 'string') : [];
}

/** The flags the director sets for the next generation (`flags(): Record<string, string>`), or null. */
export function directorCurrentFlags(app: App): Record<string, string> | null {
    const api = app.modules.api<unknown>(DIRECTOR_API_KEY);
    if (!isRecord(api)) return null;
    const flags = call(api, api.flags);
    if (!isRecord(flags)) return null;
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(flags)) result[name] = String(value);
    return result;
}

/** The director's flags that are on now ('1', 'true', … — `{{if}}` truthiness), for the simulator's «Как сейчас». */
export function directorFlagsOn(app: App): string[] {
    const flags = directorCurrentFlags(app) ?? {};
    return Object.keys(flags).filter((name) => isTruthy(variableText(flags[name])));
}

/** Flags the conditionals of a preset read (`.name` form), in block order. */
export function presetFlags(body: PresetBody): FlagEntry[] {
    const names: string[] = [];
    for (const prompt of body.prompts ?? []) {
        const info = conditionalInfo(prompt.identifier, promptText(prompt));
        if (info) names.push(...info.flags);
    }
    return readFlagEntries([...new Set(names)], 'preset');
}

/** The catalogue the studio offers: the director's flags, the fallbacks, then the preset's own. */
export function flagCatalogue(app: App, body?: PresetBody): FlagEntry[] {
    return mergeCatalogue(
        directorCatalogue(app),
        mechanicsCatalogue(app),
        FALLBACK_FLAGS,
        body ? presetFlags(body) : [],
    );
}

/** Flags Maestro owns by its catalogue (the director's and the fallbacks; not the preset's own variables). */
export function knownFlags(app: App): string[] {
    return mergeCatalogue(directorCatalogue(app), mechanicsCatalogue(app), FALLBACK_FLAGS).map((entry) => entry.name);
}

/** A flag's label: its title from the catalogue (when the key is known to i18n), else the name. */
export function flagLabel(app: App, entry: FlagEntry): string {
    if (entry.label) {
        const title = entry.titleKey ? app.i18n.t(entry.titleKey, { name: entry.label }) : '';
        return title && title !== entry.titleKey ? title : entry.label;
    }
    if (!entry.titleKey) return entry.name;
    const title = app.i18n.t(entry.titleKey);
    return title && title !== entry.titleKey ? title : entry.name;
}

export function flagHint(app: App, entry: FlagEntry): string | undefined {
    if (!entry.descriptionKey) return undefined;
    const text = app.i18n.t(entry.descriptionKey);
    return text && text !== entry.descriptionKey ? text : undefined;
}

export type MacroEngineState = 'on' | 'off' | 'unknown';

/** `power_user.experimental_macro_engine` (P-133): 'unknown' when this ST has no such setting. */
export function macroEngineState(app: App): MacroEngineState {
    let value: unknown;
    try {
        value = app.host.ctx().powerUserSettings?.experimental_macro_engine;
    } catch {
        return 'unknown';
    }
    if (value === true) return 'on';
    if (value === false) return 'off';
    return 'unknown';
}

/* ------------------------------------------------------------------ rows and the simulator */

export interface ConditionalRow {
    identifier: string;
    name: string;
    content: string;
    /** In the active prompt list. */
    listed: boolean;
    enabled: boolean;
    inChat: boolean;
    info: ConditionalBlockInfo;
    /** The block's own condition when the whole text is one conditional. */
    condition: BlockCondition | null;
    issues: ConditionalIssue[];
}

/** Blocks of the working copy with `{{if}}`: the active list in order, then those outside it. */
export function conditionalRows(
    store: PresetStore,
    known: readonly string[],
    engine: MacroEngineState,
): ConditionalRow[] {
    const prompts = store.working().prompts ?? [];
    const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
    const listed = store.prompts().map((row) => row.item);
    const ordered: { prompt: PresetPrompt; listed: boolean; enabled: boolean }[] = [];
    const seen = new Set<string>();
    for (const item of listed) {
        const prompt = byId.get(item.identifier);
        if (!prompt || seen.has(item.identifier)) continue;
        seen.add(item.identifier);
        ordered.push({ prompt, listed: true, enabled: item.enabled });
    }
    for (const prompt of prompts) {
        if (!seen.has(prompt.identifier)) ordered.push({ prompt, listed: false, enabled: false });
    }
    const rows: ConditionalRow[] = [];
    for (const { prompt, listed: inList, enabled } of ordered) {
        if (isMarker(prompt)) continue;
        const content = promptText(prompt);
        const info = conditionalInfo(prompt.identifier, content, known);
        if (!info) continue;
        rows.push({
            identifier: prompt.identifier,
            name: promptName(prompt),
            content,
            listed: inList,
            enabled,
            inChat: isInChat(prompt),
            info,
            condition: blockCondition(content),
            issues: validateConditional(content, { known, macroEngine: engine === 'off' ? false : null }),
        });
    }
    return rows;
}

export type SimulatedStatus =
    /** Goes to the model with this text. */
    | 'sent'
    /** Empty: ST drops the message. */
    | 'empty'
    /** Whitespace only: ST still sends it (P-117). */
    | 'whitespace'
    /** Switched off or outside the prompt list: not sent whatever the flags. */
    | 'off'
    /** The old macro engine: sent literally, tags and all branches. */
    | 'literal';

export interface Simulated {
    status: SimulatedStatus;
    /** What ST would send (the raw text for 'literal'). */
    text: string;
}

/** What one block sends with these flags on. */
export function simulate(row: ConditionalRow, on: ReadonlySet<string>, engine: MacroEngineState): Simulated {
    if (engine === 'off') return { status: row.enabled && row.listed ? 'literal' : 'off', text: row.content };
    const text = evaluate(row.content, on);
    if (!row.enabled || !row.listed) return { status: 'off', text };
    if (text === '') return { status: 'empty', text };
    if (!text.trim()) return { status: 'whitespace', text };
    return { status: 'sent', text };
}

/** A finding for the «Анализ» tab (rendered next to the analysis module's own). */
export interface ExtraFinding {
    label: string;
    severity: 'info' | 'warn';
    identifier?: string;
    text: string;
}

/** Codes «Анализ» already reports through the analysis module (P-133 engine, whitespace outside `{{if}}`). */
const ANALYSIS_COVERS: ReadonlySet<ConditionalIssueCode> = new Set(['macroEngineOff', 'outsideWhitespace']);

/** The text of a block issue. */
export function issueText(app: App, row: Pick<ConditionalRow, 'name'>, issue: ConditionalIssue): string {
    return app.i18n.t(`m34.cond.issue.${issue.code}`, {
        name: row.name,
        flag: issue.flag ?? '',
        flags: issue.flags?.length ? issue.flags.join(', ') : app.i18n.t('m34.cond.noFlags'),
    });
}

/**
 * Findings of the conditional blocks for «Анализ»: malformed tags, flags Maestro does not own, unsafe forms, flag
 * combinations that leave a whitespace-only message — for enabled blocks of the list. The macro engine and the
 * whitespace outside a relative block's tags are the analysis module's own findings (not repeated).
 */
export function conditionalFindings(app: App, rows: readonly ConditionalRow[]): ExtraFinding[] {
    const label = app.i18n.t('m34.cond.findingLabel');
    const result: ExtraFinding[] = [];
    for (const row of rows) {
        if (!row.listed || !row.enabled) continue;
        for (const issue of row.issues) {
            if (issue.code === 'outsideWhitespace' ? !row.inChat : ANALYSIS_COVERS.has(issue.code)) continue;
            result.push({
                label,
                severity: issue.severity,
                identifier: row.identifier,
                text: issueText(app, row, issue),
            });
        }
    }
    return result;
}

/* ------------------------------------------------------------------ «Подготовить к отключению» */

export type PrepareConditionalsMode = 'keepText' | 'disable';

export interface PrepareConditionalsReport {
    mode: PrepareConditionalsMode;
    /** The preset worked on (null: the preset store is not running). */
    preset: string | null;
    /** Blocks whose Maestro conditionals became plain text ('keepText') or were cut out ('disable', mixed text). */
    rewritten: string[];
    /** Blocks switched off ('disable': the whole text was a Maestro conditional). */
    disabled: string[];
    /** Blocks left as they were because their tags are malformed. */
    skipped: string[];
    /** The preset file was written (no layer on this preset and no unsaved edits before). */
    saved: boolean;
    /**
     * The changes are in the working copy only: with a layer, the layer step saves them («база + слой») or drops them
     * (base reselected); without one, there were unsaved edits the user has to save himself.
     */
    unsaved: boolean;
}

export interface PrepareConditionalsOptions {
    /**
     * Writing the preset file: 'auto' (default) — only without a layer on this preset and with no unsaved edits
     * before; 'always' — whenever a block changed (after the layer step 'reselectBase': store.save strips only the
     * layer's own values, so these edits stay in the base file); 'never'.
     */
    save?: 'auto' | 'always' | 'never';
}

/** Names of the blocks of the working copy that read Maestro flags (the question «Подготовить к отключению» asks). */
export function maestroConditionalBlocks(app: App): string[] {
    const store = app.modules.api<PresetStore>('presetStore');
    if (!store) return [];
    const known = knownFlags(app);
    return (store.working().prompts ?? [])
        .filter((prompt) => !isMarker(prompt) && conditionalInfo(prompt.identifier, promptText(prompt), known)?.maestro)
        .map((prompt) => promptName(prompt));
}

/**
 * «Подготовить к отключению» for conditional blocks (plan §4.9): 'keepText' — every Maestro conditional keeps the
 * text of its if-branch as plain text; 'disable' — blocks that are one Maestro conditional are switched off, mixed
 * blocks lose their Maestro parts (what ST would send without Maestro stays). Other conditionals (the user's own
 * variables, card fields) are not touched; blocks with malformed tags are reported, not changed. Works on the
 * working copy through the preset store, never through the layer (the layer is dropped or merged by its own step,
 * PresetLayerApi.prepareDisable): before 'saveMerged' (the merged preset then carries these edits), after
 * 'reselectBase' with `save: 'always'` (the base file gets them). The file is written per `options.save` (explicit
 * body, a version is written).
 */
export async function prepareConditionalsForDisable(
    app: App,
    mode: PrepareConditionalsMode,
    options: PrepareConditionalsOptions = {},
): Promise<PrepareConditionalsReport> {
    const report: PrepareConditionalsReport = {
        mode,
        preset: null,
        rewritten: [],
        disabled: [],
        skipped: [],
        saved: false,
        unsaved: false,
    };
    const store = app.modules.api<PresetStore>('presetStore');
    if (!store) return report;
    // After a reselect (the layer step) the store may still be catching up with ST's events.
    await store.whenIdle?.();
    const preset = store.current();
    report.preset = preset;
    const dirtyBefore = store.draft().dirty;
    const working = store.working();
    const known = knownFlags(app);
    const order = new Map(store.prompts().map((row) => [row.item.identifier, row.item.enabled]));
    const toDisable: string[] = [];
    for (const prompt of working.prompts ?? []) {
        if (isMarker(prompt)) continue;
        const text = promptText(prompt);
        const info = conditionalInfo(prompt.identifier, text, known);
        if (!info?.maestro) continue;
        const name = promptName(prompt);
        if (parseConditional(text).issues.length) {
            report.skipped.push(name);
            continue;
        }
        // Nothing but Maestro conditionals (whitespace aside): the block itself is switched off.
        if (mode === 'disable' && info.onlyMaestro) {
            if (order.get(prompt.identifier) === true) {
                toDisable.push(prompt.identifier);
                report.disabled.push(name);
            }
            continue;
        }
        const next = withoutMaestroConditionals(text, mode === 'keepText' ? 'then' : 'absent', known);
        if (next === text) continue;
        await store.updatePrompt(prompt.identifier, { content: next });
        report.rewritten.push(name);
    }
    if (toDisable.length) await store.setEnabled(toDisable, false);
    const changed = report.rewritten.length + report.disabled.length > 0;
    if (!changed) return report;
    const layer = app.modules.api<PresetLayerApi>('presetLayer');
    const layered = (layer?.get(preset)?.ops.length ?? 0) > 0;
    const save = options.save ?? 'auto';
    if (save === 'always' || (save === 'auto' && !layered && !dirtyBefore)) {
        await store.save(
            preset,
            app.i18n.t('m34.cond.prepare.summary', { mode: app.i18n.t(`m34.cond.prepare.${mode}`) }),
        );
        report.saved = true;
    }
    report.unsaved = !report.saved;
    return report;
}
