// Write tools over the Preset Studio (M34 through M33): a new block and a block's condition, always in the user's
// LAYER of the current preset (layer ops recorded through app.modules.api('presetLayer'), journaled there) and in
// the working copy through the preset store (Prompt Manager's own methods; the preset file is never written — no
// save without an explicit body, plan M34). Like the studio's edit router: the layer op first, then the working
// copy. Conditions wrap the block text in `{{if .flag}}…{{/if}}`; the flag is one Maestro announces (the director's
// and the mechanics' catalogues), one the preset's own conditionals already use, or a valid `maestro_*` name.
import {
    reqEnum,
    reqObject,
    reqString,
    optBool,
    optEnum,
    optInt,
    optObject,
    optString,
} from '../../../../domain/assistant-write-args';
import type { Dict } from '../../../../domain/assistant-write-args';
import {
    anchorOf,
    BLOCK_PLACES,
    CONDITION_MODES,
    conditionChoice,
    conditionedText,
    flagStanding,
    storeAfterOf,
} from '../../../../domain/assistant-write-preset';
import type { BlockAnchor, ConditionMode } from '../../../../domain/assistant-write-preset';
import { stableHash } from '../../../../domain/hash';
import { conditionalInfo, readFlagEntries } from '../../../../domain/preset-conditional-check';
import { isMaestroFlag } from '../../../../domain/preset-conditional-syntax';
import { isMarker, promptName, promptText, PROMPT_ROLES } from '../../../../domain/preset-ui-blocks';
import type { App } from '../../../../shared/contracts';
import type { DirectorApi } from '../../../director/api';
import type { PresetLayerApi } from '../../../presetStudio/layer-api';
import type { PresetBody, PresetPrompt, PresetStore } from '../../../presetStudio/store-api';
import type { ToolSpec } from '../../api';
import { argsOf, failure, newUuid, planWith } from './common';
import type { Say } from './strings';

const STORE_KEY = 'presetStore';
const LAYER_KEY = 'presetLayer';
const DEFAULT_DEPTH = 4;
const DEFAULT_ORDER = 100;

interface PresetApis {
    store: PresetStore;
    layer: PresetLayerApi;
}

function presetApis(app: App): PresetApis | null {
    const store = app.modules.api<PresetStore>(STORE_KEY);
    const layer = app.modules.api<PresetLayerApi>(LAYER_KEY);
    return store && layer ? { store, layer } : null;
}

/** The saved base body; without ST's cache, the working copy with the layer stripped (as the studio does). */
function savedBase(apis: PresetApis, base: string): PresetBody {
    const saved = apis.store.saved(base);
    if (saved) return saved;
    try {
        return apis.layer.strip(base, apis.store.working());
    } catch {
        return {};
    }
}

/** The layer's text fingerprint (the studio's baseHashOf: line ends normalised). */
function baseHashOf(text: string): string {
    return stableHash(text.replace(/\r\n/g, '\n'));
}

function call(owner: Record<string, unknown>, value: unknown): unknown {
    if (typeof value !== 'function') return value;
    try {
        return (value as () => unknown).call(owner);
    } catch {
        return undefined;
    }
}

/** Flags something in Maestro sets: the director's catalogue and the mechanics' flags (read defensively). */
function setterFlags(app: App): string[] {
    const names: string[] = [];
    const director = app.modules.api<DirectorApi & Record<string, unknown>>('director');
    if (director) {
        const list = call(director, director.catalogue ?? director.flagCatalogue);
        names.push(...readFlagEntries(Array.isArray(list) ? list : [], 'director').map((entry) => entry.name));
    }
    const mechanics = app.modules.api<Record<string, unknown>>('mechanics');
    if (mechanics) {
        const list = call(mechanics, mechanics.flagCatalogue);
        if (Array.isArray(list)) {
            for (const item of list) {
                if (item && typeof item === 'object' && typeof (item as Dict).flag === 'string') {
                    names.push((item as Dict).flag as string);
                }
            }
        }
    }
    return [...new Set(names)];
}

/** Flags the preset's own conditionals already read (the studio's catalogue keeps them too). */
function presetFlags(store: PresetStore): string[] {
    const names: string[] = [];
    for (const prompt of store.working().prompts ?? []) {
        const info = conditionalInfo(prompt.identifier, promptText(prompt));
        if (info) names.push(...info.flags);
    }
    return [...new Set(names)];
}

/** Checks the flag and returns the card's warnings about it. */
function flagWarnings(app: App, store: PresetStore, flag: string, say: Say): string[] {
    const setters = setterFlags(app);
    flagStanding(flag, [...setters, ...presetFlags(store)]);
    const warnings: string[] = [];
    // A Maestro flag nobody announces now (the director off, a mechanic of another card…) is never set.
    if (!setters.includes(flag) && isMaestroFlag(flag)) {
        warnings.push(say('m33w.preset.warn.flagNotInCatalogue', { flag }));
    }
    // `{{if}}` exists only in the new macro engine (P-133); ST 1.19 has it on by default.
    if (app.host.ctx().powerUserSettings?.experimental_macro_engine === false) {
        warnings.push(say('m33w.preset.warn.macroEngine'));
    }
    return warnings;
}

/** A block of a list by identifier, else by its name (case-insensitive, unique). */
function findBlock<T extends { identifier: string; prompt: PresetPrompt | null }>(
    rows: readonly T[],
    wanted: string,
    say: Say,
    preset: string,
): T {
    const exact = rows.find((row) => row.identifier === wanted);
    if (exact) return exact;
    const lower = wanted.trim().toLowerCase();
    const named = rows.filter((row) => row.prompt && promptName(row.prompt).trim().toLowerCase() === lower);
    if (named.length > 1) throw failure(say, 'presetAmbiguous', { block: wanted });
    if (!named[0]) throw failure(say, 'presetNoBlock', { block: wanted, preset });
    return named[0];
}

function rowsOf(store: PresetStore): { identifier: string; prompt: PresetPrompt | null }[] {
    return store.prompts().map((row) => ({ identifier: row.item.identifier, prompt: row.prompt }));
}

function placeText(say: Say, anchor: BlockAnchor, label: string, depth: number | undefined): string {
    const place = say(`m33w.preset.place.${anchor.kind}`, { block: label });
    return depth === undefined ? place : `${place}, ${say('m33w.preset.place.depth', { depth })}`;
}

/* ------------------------------------------------------------------ preset_block_add */

export function presetBlockAddTool(): ToolSpec {
    return {
        name: 'preset_block_add',
        kind: 'write',
        description:
            "Adds a new prompt block to the user's own layer of the current Chat Completion preset (the base preset " +
            'file is never changed; the layer survives preset updates). position.place: start, end, after or ' +
            'before (position.block: the identifier or name of a block in the prompt list); position.depth puts it ' +
            'into the chat at that depth. condition: send the block only when a Maestro flag is set (mode "only") ' +
            'or except then ("except"), e.g. maestro_scene_combat. Blocks and the flag catalogue: preset_blocks.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Block name shown in the prompt list.' },
                role: { type: 'string', enum: [...PROMPT_ROLES], description: 'Message role (default system).' },
                content: { type: 'string', description: 'Block text (macros like {{char}} allowed).' },
                position: {
                    type: 'object',
                    description: 'Where the block goes: {place, block, depth}.',
                    properties: {
                        place: { type: 'string', enum: [...BLOCK_PLACES] },
                        block: { type: 'string' },
                        depth: { type: 'integer', minimum: 0, maximum: 9999 },
                    },
                    required: ['place'],
                    additionalProperties: false,
                },
                enabled: { type: 'boolean', description: 'Default true.' },
                condition: {
                    type: 'object',
                    description: 'Optional: {flag, mode: only or except}.',
                    properties: {
                        flag: { type: 'string' },
                        mode: { type: 'string', enum: ['only', 'except'] },
                    },
                    required: ['flag', 'mode'],
                    additionalProperties: false,
                },
            },
            required: ['name', 'content', 'position'],
            additionalProperties: false,
        },
        available: (app) => presetApis(app) !== null,
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const app = ctx.app;
                const apis = presetApis(app);
                if (!apis) throw failure(say, 'presetUnavailable');
                const args = argsOf(raw);
                const name = reqString(args, 'name', { max: 100 });
                const role = optEnum(args, 'role', PROMPT_ROLES) ?? 'system';
                let content = reqString(args, 'content', { raw: true, max: 20000 }).trim();
                const position = reqObject(args, 'position');
                const place = reqEnum(position, 'place', BLOCK_PLACES);
                const depth = optInt(position, 'depth', 0, 9999);
                const enabled = optBool(args, 'enabled') ?? true;
                const condition = optObject(args, 'condition');
                const base = apis.store.current();
                if (!base) throw failure(say, 'presetNone');
                let anchorLabel = '';
                let anchorId: string | null = null;
                if (place === 'after' || place === 'before') {
                    const wanted = optString(position, 'block', { max: 200 });
                    if (!wanted) throw failure(say, 'presetNeedAnchor', { place });
                    const row = findBlock(rowsOf(apis.store), wanted, say, base);
                    anchorId = row.identifier;
                    anchorLabel = row.prompt ? promptName(row.prompt) : row.identifier;
                }
                const anchor = anchorOf(place, anchorId);
                const warnings: string[] = [];
                let conditionText = '';
                if (condition) {
                    const flag = reqString(condition, 'flag', { max: 100 });
                    const mode = reqEnum(condition, 'mode', ['only', 'except'] as const);
                    warnings.push(...flagWarnings(app, apis.store, flag, say));
                    content = conditionedText(content, conditionChoice(mode, flag));
                    conditionText = say(`m33w.preset.cond.${mode}`, { flag });
                }
                if (!enabled) warnings.push(say('m33w.preset.warn.disabled'));
                const prompt: PresetPrompt = {
                    identifier: newUuid(app),
                    name,
                    role,
                    content,
                    system_prompt: false,
                    marker: false,
                    injection_position: depth === undefined ? 0 : 1,
                    injection_depth: depth ?? DEFAULT_DEPTH,
                    injection_order: DEFAULT_ORDER,
                    forbid_overrides: false,
                };
                const where = placeText(say, anchor, anchorLabel, depth);
                const after: Dict = { name, role, place: where, enabled, content };
                if (warnings.length) after.warnings = warnings;
                return {
                    summary: say('m33w.preset.summary.add', { name, role, place: where, condition: conditionText }),
                    target: say('m33w.target.preset', { preset: base }),
                    before: null,
                    after,
                    async apply() {
                        const live = presetApis(app);
                        if (!live) throw failure(say, 'presetUnavailable');
                        const current = live.store.current();
                        if (current !== base) throw failure(say, 'presetChanged', { preset: base, current });
                        // The layer first (it is what survives a new base), then the working copy for this session.
                        await live.layer.record(base, { op: 'add', prompt, anchor, enabled });
                        const order = live.store.prompts().map((row) => row.item.identifier);
                        const identifier = await live.store.addPrompt(
                            { ...prompt, enabled },
                            storeAfterOf(order, anchor),
                        );
                        const row = live.store.prompts().find((item) => item.item.identifier === identifier);
                        if (row && row.item.enabled !== enabled) await live.store.setEnabled([identifier], enabled);
                        return { result: { identifier, preset: base } };
                    },
                };
            }),
    };
}

/* ------------------------------------------------------------------ preset_block_condition */

export function presetBlockConditionTool(): ToolSpec {
    return {
        name: 'preset_block_condition',
        kind: 'write',
        description:
            "Puts a condition on a block of the current preset, recorded in the user's layer (the base file is " +
            'never changed): mode "only" sends it only when the flag is set, "except" only when it is not, ' +
            '"always" removes the block\'s condition. The flag is a Maestro flag such as maestro_scene_combat ' +
            "(the director's and the mechanics' catalogue, or a maestro_… name).",
        parameters: {
            type: 'object',
            properties: {
                block: { type: 'string', description: 'Identifier or name of the block.' },
                flag: { type: 'string', description: 'Flag name, e.g. maestro_scene_combat (not for always).' },
                mode: { type: 'string', enum: [...CONDITION_MODES], description: 'only, except, or always.' },
            },
            required: ['block', 'mode'],
            additionalProperties: false,
        },
        available: (app) => presetApis(app) !== null,
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const app = ctx.app;
                const apis = presetApis(app);
                if (!apis) throw failure(say, 'presetUnavailable');
                const args = argsOf(raw);
                const wanted = reqString(args, 'block', { max: 200 });
                const mode: ConditionMode = reqEnum(args, 'mode', CONDITION_MODES);
                const flag = optString(args, 'flag', { max: 100 }) ?? null;
                const { store, layer } = apis;
                const base = store.current();
                if (!base) throw failure(say, 'presetNone');
                const prompts = store.working().prompts ?? [];
                const row = findBlock(
                    prompts.map((prompt) => ({ identifier: prompt.identifier, prompt })),
                    wanted,
                    say,
                    base,
                );
                const prompt = row.prompt as PresetPrompt;
                const identifier = prompt.identifier;
                const name = promptName(prompt);
                if (isMarker(prompt)) throw failure(say, 'presetMarker', { name });
                const own = (layer.get(base)?.ops ?? []).some(
                    (op) => op.op === 'add' && op.prompt.identifier === identifier,
                );
                const basePrompt = (savedBase(apis, base).prompts ?? []).find((item) => item.identifier === identifier);
                if (!own && !basePrompt) throw failure(say, 'presetOutside', { name });
                const choice = conditionChoice(mode, flag);
                const warnings = mode !== 'always' && flag ? flagWarnings(app, store, flag, say) : [];
                const content = promptText(prompt);
                const next = conditionedText(content, choice);
                if (next === content) throw failure(say, 'presetAlready', { name });
                const baseText = own || !basePrompt ? '' : promptText(basePrompt);
                const after: Dict = { text: next };
                if (warnings.length) after.warnings = warnings;
                return {
                    summary: say(`m33w.preset.summary.${mode}`, { name, flag: flag ?? '' }),
                    target: say('m33w.target.presetBlock', { preset: base, name }),
                    before: { text: content },
                    after,
                    async apply() {
                        const live = presetApis(app);
                        if (!live) throw failure(say, 'presetUnavailable');
                        const current = live.store.current();
                        if (current !== base) throw failure(say, 'presetChanged', { preset: base, current });
                        const now = (live.store.working().prompts ?? []).find((item) => item.identifier === identifier);
                        if (!now || promptText(now) !== content) throw failure(say, 'presetBlockChanged', { name });
                        await live.layer.record(base, {
                            op: 'edit',
                            identifier,
                            patch: { content: next },
                            baseHash: baseHashOf(baseText),
                            baseText,
                        });
                        await live.store.updatePrompt(identifier, { content: next });
                        return { result: { identifier, preset: base } };
                    },
                };
            }),
    };
}
