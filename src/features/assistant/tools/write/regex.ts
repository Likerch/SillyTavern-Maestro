// Write tools over SillyTavern's regex scripts (M33 «регексы с испытанием»). Only GLOBAL scripts are written: they
// live in `extension_settings.regex` (settings.json, ST 1.19 extensions/regex/engine.js getScriptsByType /
// saveScriptsByType → saveSettingsDebounced); scoped scripts are part of a character card and preset scripts of a
// preset file — never written here. A new script must pass its test (samples run the way ST runs scripts, shown in
// the card) before it can be confirmed. Writes go through ST's engine when it loads (the same stores otherwise),
// toggles flip `disabled` on the live object as ST's /regex-toggle does, the guardian (M4) is told so the change is
// not reported as drift, and every change is journaled with undo (target 'assistant-regex').
import {
    clip,
    isDict,
    jsonCopy,
    optBool,
    optEnum,
    optInt,
    optObject,
    optString,
    optStringList,
    reqBool,
    reqString,
    reqStringList,
    ArgError,
} from '../../../../domain/assistant-write-args';
import type { Dict } from '../../../../domain/assistant-write-args';
import {
    buildRegexScript,
    expectedMismatches,
    isForeignScriptRef,
    locateScript,
    PLACEMENT_NAMES,
    REGEX_MODES,
    regexWarnings,
    runSamples,
    scriptView,
    SUBSTITUTE_NAMES,
} from '../../../../domain/assistant-write-regex';
import type { PlacementName, StRegexScript } from '../../../../domain/assistant-write-regex';
import type { App, JournalChange } from '../../../../shared/contracts';
import type { DoctorApi } from '../../../doctor/api';
import type { GuardianApi } from '../../../guardian/api';
import type { ToolSpec } from '../../api';
import { argsOf, failure, journal, newUuid, planWith, UNDO_TARGETS } from './common';

const MAX_SAMPLES = 5;
const MAX_SAMPLE_LENGTH = 4000;

/** The global scripts and how to save a new list. `list` is ST's own array (items of any shape kept). */
export interface GlobalRegexStore {
    list: unknown[];
    save(next: unknown[]): Promise<void>;
}

async function regexEngine(app: App): Promise<Dict | null> {
    if (!app.host.caps.has('st.regex')) return null;
    try {
        return await app.host.modules.regexEngine();
    } catch {
        return null;
    }
}

function extensionSettings(app: App): Dict | null {
    try {
        const settings = app.host.ctx().extensionSettings;
        return isDict(settings) ? settings : null;
    } catch {
        return null;
    }
}

/** ST's global scripts: through the engine (`getScriptsByType(GLOBAL)`), else `extension_settings.regex`. */
export async function globalRegexStore(app: App): Promise<GlobalRegexStore | null> {
    const engine = await regexEngine(app);
    const read = engine?.getScriptsByType;
    const write = engine?.saveScriptsByType;
    if (typeof read === 'function' && typeof write === 'function') {
        const codes = isDict(engine?.SCRIPT_TYPES) ? engine.SCRIPT_TYPES : {};
        const code = typeof codes.GLOBAL === 'number' ? codes.GLOBAL : 0;
        const list: unknown = (read as (type: number, options: { allowedOnly: boolean }) => unknown)(code, {
            allowedOnly: false,
        });
        return {
            list: Array.isArray(list) ? list : [],
            save: async (next) => {
                await (write as (scripts: unknown[], type: number) => unknown)(next, code);
            },
        };
    }
    const settings = extensionSettings(app);
    if (!settings) return null;
    return {
        list: Array.isArray(settings.regex) ? settings.regex : [],
        save: async (next) => {
            const ctx = app.host.ctx();
            ctx.extensionSettings.regex = next;
            ctx.saveSettingsDebounced();
        },
    };
}

function regexAvailable(app: App): boolean {
    return app.host.caps.has('st.regex') || Array.isArray(extensionSettings(app)?.regex);
}

function extensionOff(app: App): boolean {
    const disabled = extensionSettings(app)?.disabledExtensions;
    return Array.isArray(disabled) && disabled.includes('regex');
}

/**
 * After a write: the guardian acknowledges the change; the doctor's regex inventory (regex_list reads it) is rescanned
 * in the background when it has one, as the doctor does after its own regex fixes; ST's regex panel is redrawn when
 * its module exports a loader (1.19 does not — the panel then shows the change on its next redraw: chat or preset
 * switch, reopening).
 */
async function afterWrite(app: App): Promise<void> {
    try {
        await app.modules.api<GuardianApi>('guardian')?.acknowledge(['regex']);
    } catch (error) {
        app.log.warn('assistant: guardian acknowledge failed', error);
    }
    const doctor = app.modules.api<DoctorApi>('doctor');
    if (doctor && (doctor.lastScanAt?.() ?? 0) > 0) {
        void doctor.scan().catch((error: unknown) => app.log.debug('assistant: doctor rescan failed', error));
    }
    if (!app.host.caps.has('st.regex') || extensionOff(app)) return;
    try {
        const module = await app.host.modules.load('extensions/regex/index.js');
        const reload = module.loadRegexScripts;
        if (typeof reload === 'function') await (reload as () => unknown)();
    } catch (error) {
        app.log.debug('assistant: regex list not reloaded', error);
    }
}

function asScripts(list: readonly unknown[]): Dict[] {
    return list.map((item) => (isDict(item) ? item : {}));
}

function nameOf(script: Dict): string {
    return typeof script.scriptName === 'string' && script.scriptName ? script.scriptName : String(script.id ?? '');
}

/* ------------------------------------------------------------------ regex_create */

function readPlacement(args: Dict): PlacementName[] {
    const items = reqStringList(args, 'placement', {
        maxItems: PLACEMENT_NAMES.length,
        unique: true,
        fromString: 'split',
    });
    return items.map((item) => {
        const name = PLACEMENT_NAMES.find((option) => option === item.trim().toLowerCase());
        if (!name) throw new ArgError('argEnum', { name: 'placement', options: PLACEMENT_NAMES.join(', ') });
        return name;
    });
}

export function regexCreateTool(): ToolSpec {
    return {
        name: 'regex_create',
        kind: 'write',
        description:
            'Adds a GLOBAL SillyTavern regex script, tested first: `samples` (1–5 texts it should act on) are run ' +
            'through it and the user sees each sample before/after; at least one sample must change, and ' +
            '`expected` (one result per sample) makes the test exact. `find` is a pattern or "/pattern/flags" ' +
            '(flags g i m s u; default g); write line breaks as \\n. `replace` may use $1, $<name>, {{match}}. ' +
            'placement: user_input, ai_output, slash_command, world_info, reasoning. options.mode: display ' +
            '(default; only what is shown), prompt (only what is sent), displayAndPrompt, edit (changes the stored ' +
            'message text). Character-card and preset regexes are never written.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Script name shown in the regex list.' },
                find: { type: 'string', description: 'Pattern, or "/pattern/flags".' },
                replace: { type: 'string', description: 'Replacement ($1, $<name>, {{match}}); empty removes.' },
                flags: { type: 'string', description: 'Regex flags when `find` is a bare pattern (default "g").' },
                placement: {
                    type: 'array',
                    items: { type: 'string', enum: [...PLACEMENT_NAMES] },
                    description: 'Where it acts.',
                },
                options: {
                    type: 'object',
                    description:
                        'mode, runOnEdit (default true), trimStrings, minDepth, maxDepth, substitute, disabled.',
                    properties: {
                        mode: { type: 'string', enum: [...REGEX_MODES] },
                        runOnEdit: { type: 'boolean' },
                        trimStrings: { type: 'array', items: { type: 'string' } },
                        minDepth: { type: 'integer', minimum: -1 },
                        maxDepth: { type: 'integer', minimum: 0 },
                        substitute: { type: 'string', enum: [...SUBSTITUTE_NAMES] },
                        disabled: { type: 'boolean' },
                    },
                    additionalProperties: false,
                },
                samples: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    maxItems: MAX_SAMPLES,
                    description: 'Texts to test the regex on (the required test).',
                },
                expected: {
                    type: 'array',
                    items: { type: 'string' },
                    maxItems: MAX_SAMPLES,
                    description: 'Optional: the exact result for each sample.',
                },
            },
            required: ['name', 'find', 'placement', 'samples'],
            additionalProperties: false,
        },
        available: regexAvailable,
        plan: (raw, ctx) =>
            planWith(ctx, async (say) => {
                const app = ctx.app;
                const args = argsOf(raw);
                const options = optObject(args, 'options') ?? {};
                const draft = {
                    name: reqString(args, 'name', { max: 100 }),
                    find: reqString(args, 'find', { raw: true, max: 5000 }),
                    replace: optString(args, 'replace', { raw: true, allowEmpty: true, max: 20000 }) ?? '',
                    flags: optString(args, 'flags', { allowEmpty: true, max: 10 }),
                    placement: readPlacement(args),
                    mode: optEnum(options, 'mode', REGEX_MODES) ?? 'display',
                    runOnEdit: optBool(options, 'runOnEdit') ?? true,
                    trimStrings:
                        optStringList(options, 'trimStrings', { maxItems: 20, maxLength: 200, raw: true }) ?? [],
                    minDepth: optInt(options, 'minDepth', -1, 9999) ?? null,
                    maxDepth: optInt(options, 'maxDepth', 0, 9999) ?? null,
                    substitute: optEnum(options, 'substitute', SUBSTITUTE_NAMES) ?? 'none',
                    disabled: optBool(options, 'disabled') ?? false,
                };
                const samples = reqStringList(args, 'samples', {
                    maxItems: MAX_SAMPLES,
                    maxLength: MAX_SAMPLE_LENGTH,
                    raw: true,
                });
                const expected = optStringList(args, 'expected', {
                    maxItems: MAX_SAMPLES,
                    maxLength: MAX_SAMPLE_LENGTH,
                    raw: true,
                });
                const store = await globalRegexStore(app);
                if (!store) throw failure(say, 'regexUnavailable');
                const script = buildRegexScript(draft, newUuid(app));
                // The required test: the regex must do something to the samples, and exactly what was expected.
                const results = runSamples(script, samples);
                if (!results.some((result) => result.changed)) throw failure(say, 'regexNoMatch');
                if (expected) {
                    const mismatch = expectedMismatches(results, expected)[0];
                    if (mismatch) {
                        throw failure(say, 'regexExpected', {
                            index: mismatch.index,
                            expected: clip(mismatch.expected, 200),
                            actual: clip(mismatch.actual, 200),
                        });
                    }
                }
                const names = asScripts(store.list).map(nameOf);
                const warnings = regexWarnings(script, names).map((code) => say(`m33w.regex.warn.${code}`));
                if (extensionOff(app)) warnings.push(say('m33w.regex.warn.extensionOff'));
                const changed = results.filter((result) => result.changed).length;
                const after: Dict = { regex: scriptView(script), samples: results.map((result) => result.output) };
                if (warnings.length) after.warnings = warnings;
                return {
                    summary: say('m33w.regex.summary.create', {
                        name: script.scriptName,
                        where: draft.placement.map((place) => say(`m33w.regex.place.${place}`)).join(', '),
                        mode: say(`m33w.regex.mode.${draft.mode}`),
                        changed,
                        total: results.length,
                    }),
                    target: say('m33w.target.regex'),
                    before: { regex: null, samples: results.map((result) => result.input) },
                    after,
                    async apply() {
                        const live = await globalRegexStore(app);
                        if (!live) throw failure(say, 'regexUnavailable');
                        const stored: StRegexScript = jsonCopy(script);
                        if (asScripts(live.list).some((item) => item.id === stored.id)) stored.id = newUuid(app);
                        await live.save([...live.list, stored]);
                        await afterWrite(app);
                        await journal(app, {
                            kind: 'assistant.regexCreate',
                            summary: say('m33w.regex.journal.create', { name: stored.scriptName }),
                            change: {
                                target: UNDO_TARGETS.regex,
                                ref: { op: 'create', scriptId: stored.id, name: stored.scriptName },
                                before: null,
                                after: jsonCopy(stored),
                            },
                        });
                        return { result: { id: stored.id, name: stored.scriptName } };
                    },
                };
            }),
    };
}

/* ------------------------------------------------------------------ regex_toggle */

export function regexToggleTool(): ToolSpec {
    return {
        name: 'regex_toggle',
        kind: 'write',
        description:
            'Switches an existing GLOBAL SillyTavern regex script on or off (by its id from regex_list, ' +
            '"global:…", its uuid, or its exact name). Character-card and preset regexes are not switched here.',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Script uuid, a "global:" id, or the exact name.' },
                on: { type: 'boolean', description: 'true: switch on, false: switch off.' },
            },
            required: ['id', 'on'],
            additionalProperties: false,
        },
        available: regexAvailable,
        plan: (raw, ctx) =>
            planWith(ctx, async (say) => {
                const app = ctx.app;
                const args = argsOf(raw);
                const wanted = reqString(args, 'id', { max: 200 });
                const on = reqBool(args, 'on');
                if (isForeignScriptRef(wanted)) throw failure(say, 'regexForeign', { id: wanted });
                const store = await globalRegexStore(app);
                if (!store) throw failure(say, 'regexUnavailable');
                const scripts = asScripts(store.list);
                const found = locateScript(scripts, wanted);
                if (found.ambiguous) throw failure(say, 'regexAmbiguous', { id: wanted });
                const script = scripts[found.index];
                if (!script) throw failure(say, 'regexUnknown', { id: wanted });
                const name = nameOf(script);
                const enabled = script.disabled !== true;
                const state = (value: boolean) => say(value ? 'm33w.state.on' : 'm33w.state.off');
                if (enabled === on) throw failure(say, 'regexAlready', { name, state: state(on) });
                const scriptId = typeof script.id === 'string' ? script.id : '';
                return {
                    summary: say(on ? 'm33w.regex.summary.on' : 'm33w.regex.summary.off', { name }),
                    target: say('m33w.target.regex'),
                    before: { name, enabled },
                    after: { name, enabled: on },
                    async apply() {
                        const live = await globalRegexStore(app);
                        if (!live) throw failure(say, 'regexUnavailable');
                        const list = asScripts(live.list);
                        const index = locateScript(list, scriptId || name).index;
                        const target = index >= 0 ? (live.list[index] as Dict | undefined) : undefined;
                        if (!target || !isDict(target)) throw failure(say, 'regexGone', { name });
                        const previous = target.disabled === true;
                        target.disabled = !on;
                        await live.save(live.list);
                        await afterWrite(app);
                        await journal(app, {
                            kind: 'assistant.regexToggle',
                            summary: say('m33w.regex.journal.toggle', { name, state: state(on) }),
                            change: {
                                target: UNDO_TARGETS.regex,
                                ref: { op: 'toggle', scriptId, name },
                                before: { disabled: previous },
                                after: { disabled: !on },
                            },
                        });
                        return { result: { id: scriptId, name, enabled: on } };
                    },
                };
            }),
    };
}

/* ------------------------------------------------------------------ undo */

/** The fields that make a script what it is (a later on/off switch does not count as an edit). */
const CORE_FIELDS = ['scriptName', 'findRegex', 'replaceString', 'placement', 'markdownOnly', 'promptOnly'] as const;

function sameCore(a: Dict, b: Dict): boolean {
    return CORE_FIELDS.every((field) => JSON.stringify(a[field] ?? null) === JSON.stringify(b[field] ?? null));
}

/** Journal undo: a created script is removed (unless edited since), a switched one gets its previous state. */
export async function undoRegex(app: App, change: JournalChange): Promise<boolean> {
    const ref = change.ref;
    const store = await globalRegexStore(app);
    if (!store) return false;
    const scripts = asScripts(store.list);
    const scriptId = typeof ref.scriptId === 'string' ? ref.scriptId : '';
    const name = typeof ref.name === 'string' ? ref.name : '';
    if (ref.op === 'create') {
        const index = scriptId ? scripts.findIndex((script) => script.id === scriptId) : -1;
        if (index < 0) return true;
        if (!isDict(change.after) || !sameCore(scripts[index]!, change.after)) return false;
        await store.save(store.list.filter((_, position) => position !== index));
        await afterWrite(app);
        return true;
    }
    if (ref.op === 'toggle') {
        const index = locateScript(scripts, scriptId || name).index;
        const live = index >= 0 ? store.list[index] : undefined;
        if (!isDict(live) || !isDict(change.after) || !isDict(change.before)) return false;
        // Switched again since (by the user or ST's panel): leave it.
        if ((live.disabled === true) !== (change.after.disabled === true)) return false;
        live.disabled = change.before.disabled === true;
        await store.save(store.list);
        await afterWrite(app);
        return true;
    }
    return false;
}
