// Write tools over whole presets (M33 over M34, plan-2 §1 п. 4 and «Области действия» п. 2): a new preset (from
// scratch, from the current one or from blocks of several presets, a pasted foreign preset among them) written through
// the store's explicit-body save (addresses and passwords never taken from the body), a preset bound to the character
// or the chat (the studio's binder switches to it through its unsaved-edits question), a save of edits made outside
// the layer, and a version brought back. Each is a card the user confirms; the store and the layer journal with undo,
// the card groups their records (common.ts grouped()).
import {
    ArgError,
    isDict,
    optBool,
    optEnum,
    optInt,
    optString,
    reqEnum,
    reqString,
} from '../../../../domain/assistant-write-args';
import type { Dict } from '../../../../domain/assistant-write-args';
import { composePreset, emptyPreset, NEW_BLOCK_PLACES } from '../../../../domain/assistant-write-presets';
import type { ComposeAddition, ComposePrompt, ComposedPreset } from '../../../../domain/assistant-write-presets';
import { effectiveOrder, promptsOf } from '../../../../domain/preset-layer-apply';
import { normalizePrompt, promptName, PROMPT_ROLES } from '../../../../domain/preset-ui-blocks';
import type { App } from '../../../../shared/contracts';
import type { PresetBody, PresetPrompt, PresetStore } from '../../../presetStudio/store-api';
import type { ToolSpec, WritePlan } from '../../api';
import { lookupBlock, bodyRows, presetApis, presetStore, scopeContext } from '../preset-common';
import type { PresetApis } from '../preset-common';
import { argsOf, failure, grouped, listOf, newUuid, planWith } from './common';
import { MAX_BLOCK_TEXT } from './preset-changes';
import type { Say } from './strings';

/** Prompt Manager's global order list (preset-layer-apply GLOBAL_ORDER_ID). */
const GLOBAL_ORDER_ID = 100001;
const MAX_NEW_BLOCKS = 40;
const MAX_PASTED = 2_000_000;

/** The store's error codes in the user's words. */
const STORE_ERRORS: Readonly<Record<string, string>> = {
    unavailable: 'm33w.err.presetStoreUnavailable',
    'not-found': 'm33w.err.presetStoreMissing',
    exists: 'm33w.err.presetStoreExists',
    invalid: 'm33w.err.presetStoreInvalid',
    busy: 'm33w.err.presetStoreBusy',
    cancelled: 'm33w.err.presetStoreCancelled',
    protected: 'm33w.err.presetStoreProtected',
    http: 'm33w.err.presetStoreHttp',
};

/** A store failure as a sentence of the user's language (other errors pass as they are). */
async function storeCall<T>(say: Say, work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        const code = isDict(error) && error.name === 'PresetStoreError' ? String(error.code) : '';
        const key = STORE_ERRORS[code];
        if (key) throw new Error(say(key), { cause: error });
        throw error;
    }
}

function names(store: PresetStore): string[] {
    try {
        return store.names();
    } catch {
        return [];
    }
}

/** A preset of ST's list by its exact name, else case-insensitively. */
function presetNamed(store: PresetStore, wanted: string, say: Say): string {
    const list = names(store);
    if (list.includes(wanted)) return wanted;
    const lower = wanted.trim().toLowerCase();
    const found = list.filter((name) => name.toLowerCase() === lower);
    if (found.length === 1) return found[0]!;
    throw failure(say, 'presetUnknown', { preset: wanted, list: listOf(list) });
}

function requireApis(app: App, say: Say): PresetApis {
    const apis = presetApis(app);
    if (!apis) throw failure(say, 'presetUnavailable');
    return apis;
}

function bindWord(say: Say, scope: 'character' | 'chat', character: string): string {
    return scope === 'chat' ? say('m33w.bind.toChat') : say('m33w.bind.toCharacter', { character });
}

/* ------------------------------------------------------------------ preset_create */

/** A block picked from a preset body (the layer's foreign split: no markers, strict types). */
function pickBlock(apis: PresetApis, body: PresetBody, wanted: string, source: string, say: Say): PresetPrompt {
    const blocks = apis.layer.importForeign(body);
    const found = lookupBlock(
        blocks.map((prompt, index) => ({ identifier: prompt.identifier, prompt, enabled: true, index })),
        wanted,
    );
    if ('row' in found) return { ...found.row.prompt };
    if (found.problem === 'ambiguous') throw failure(say, 'presetAmbiguous', { block: wanted });
    throw failure(say, 'presetNoBlock', { block: wanted, preset: source });
}

function newBlock(item: Dict, app: App): PresetPrompt {
    const name = reqString(item, 'name', { max: 100 });
    const content = reqString(item, 'content', { raw: true, max: MAX_BLOCK_TEXT });
    const role = optEnum(item, 'role', PROMPT_ROLES) ?? 'system';
    const depth = optInt(item, 'depth', 0, 9999);
    return normalizePrompt({
        identifier: newUuid(app),
        name,
        role,
        content,
        system_prompt: false,
        marker: false,
        injection_position: depth === undefined ? 0 : 1,
        injection_depth: depth ?? 4,
        injection_order: 100,
        forbid_overrides: false,
    });
}

export function presetCreateTool(): ToolSpec {
    return {
        name: 'preset_create',
        kind: 'write',
        description:
            'Creates a new Chat Completion preset file. start: current (the preset as it works now, with the ' +
            "user's global layer edits; edits of this character or chat stay out), empty (SillyTavern's fresh preset) " +
            'or preset (another saved preset, `preset`). blocks: blocks to add — new ones {name, content, role, ' +
            'depth} or picked ones {from_preset, block} (from a saved preset) / {pasted: true, block} (from ' +
            '`pasted_preset`, a preset JSON the user pasted), each with place (beforeHistory, afterHistory, start, ' +
            'end) and enabled. bind: bind the new preset to this character or chat at once; select: switch to it now.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the new preset (must be new).' },
                start: {
                    type: 'string',
                    enum: ['current', 'empty', 'preset'],
                    description: 'What it starts from (default current).',
                },
                preset: { type: 'string', description: 'The saved preset to start from (start: preset).' },
                blocks: {
                    type: 'array',
                    description:
                        'Blocks to add: new {name, content, role, depth} or picked {from_preset|pasted, block}.',
                    items: { type: 'object' },
                },
                pasted_preset: { type: 'string', description: 'JSON text of a foreign preset the user pasted.' },
                bind: {
                    type: 'string',
                    enum: ['character', 'chat'],
                    description: 'Bind it to this character or chat.',
                },
                select: { type: 'boolean', description: 'Switch to the new preset now (default false).' },
            },
            required: ['name'],
            additionalProperties: false,
        },
        available: (app) => presetApis(app) !== null && typeof presetStore(app)?.createFromBody === 'function',
        plan: (raw, ctx) =>
            planWith(ctx, async (say): Promise<WritePlan> => {
                const app = ctx.app;
                const apis = requireApis(app, say);
                const { store, layer } = apis;
                if (typeof store.createFromBody !== 'function') throw failure(say, 'presetUnavailable');
                const args = argsOf(raw);
                const name = reqString(args, 'name', { max: 100 });
                if (names(store).some((item) => item.toLowerCase() === name.toLowerCase())) {
                    throw failure(say, 'presetExists', { preset: name });
                }
                const start = optEnum(args, 'start', ['current', 'empty', 'preset'] as const) ?? 'current';
                const current = store.current();
                let body: PresetBody;
                let baseWord: string;
                if (start === 'empty') {
                    body = {};
                    baseWord = say('m33w.create.base.empty');
                } else if (start === 'preset') {
                    const source = presetNamed(store, reqString(args, 'preset', { max: 200 }), say);
                    body = store.saved(source) ?? {};
                    baseWord = say('m33w.create.base.preset', { preset: source });
                } else {
                    if (!current) throw failure(say, 'presetNone');
                    // What works everywhere: the base with the global layer, without this card's and chat's edits.
                    body = layer.strip(current, store.working(), ['character', 'chat']);
                    baseWord = say('m33w.create.base.current', { preset: current });
                }
                const base: ComposedPreset =
                    start === 'empty'
                        ? emptyPreset()
                        : {
                              prompts: promptsOf(body) as ComposePrompt[],
                              order: effectiveOrder(body).map((item) => ({ ...item })),
                          };
                const pastedText = optString(args, 'pasted_preset', { raw: true, max: MAX_PASTED });
                let pasted: PresetBody | null = null;
                if (pastedText !== undefined) {
                    try {
                        const parsed: unknown = JSON.parse(pastedText);
                        if (isDict(parsed)) pasted = parsed as PresetBody;
                    } catch {
                        pasted = null;
                    }
                    if (!pasted) throw failure(say, 'presetPastedInvalid');
                }
                const list = args.blocks;
                if (list !== undefined && list !== null && !Array.isArray(list)) {
                    throw new ArgError('argType', { name: 'blocks', expected: 'list' });
                }
                const items = Array.isArray(list) ? list : [];
                if (items.length > MAX_NEW_BLOCKS)
                    throw new ArgError('argTooMany', { name: 'blocks', max: MAX_NEW_BLOCKS });
                const additions: ComposeAddition[] = [];
                const added: string[] = [];
                for (const item of items) {
                    if (!isDict(item)) throw new ArgError('argType', { name: 'blocks', expected: 'object' });
                    let prompt: PresetPrompt;
                    if (item.pasted === true || typeof item.from_preset === 'string') {
                        const wanted = reqString(item, 'block', { max: 200 });
                        let source: string;
                        let from: PresetBody;
                        if (item.pasted === true) {
                            if (!pasted) throw failure(say, 'presetPastedMissing');
                            source = say('m33w.create.pasted');
                            from = pasted;
                        } else {
                            source = presetNamed(store, String(item.from_preset), say);
                            from = store.saved(source) ?? {};
                        }
                        prompt = pickBlock(apis, from, wanted, source, say);
                        const rename = optString(item, 'name', { max: 100 });
                        if (rename) prompt.name = rename;
                        added.push(say('m33w.create.picked', { name: promptName(prompt), preset: source }));
                    } else {
                        prompt = newBlock(item, app);
                        added.push(say('m33w.create.new', { name: promptName(prompt) }));
                    }
                    const place = optEnum(item, 'place', NEW_BLOCK_PLACES) ?? 'beforeHistory';
                    const enabled = optBool(item, 'enabled') ?? true;
                    additions.push({ prompt: prompt as ComposePrompt, place, enabled });
                }
                const composed = composePreset(base, additions, () => newUuid(app));
                const next: PresetBody = { ...body };
                delete next.prompts;
                delete next.prompt_order;
                next.prompts = composed.prompts as PresetPrompt[];
                next.prompt_order = [{ character_id: GLOBAL_ORDER_ID, order: composed.order }];
                const bind = optEnum(args, 'bind', ['character', 'chat'] as const);
                const context = scopeContext(layer);
                if (bind) {
                    if (typeof layer.bind !== 'function') throw failure(say, 'presetBindUnavailable');
                    if (!context?.[bind]) throw failure(say, 'presetBindNoChat');
                }
                const select = optBool(args, 'select') ?? false;
                const character = context?.character?.name ?? '';
                const blockNames = bodyRows(next)
                    .filter((row) => row.enabled === true)
                    .map((row) => promptName(row.prompt));
                const after: Dict = {
                    [say('m33w.field.name')]: name,
                    [say('m33w.field.base')]: baseWord,
                    [say('m33w.field.blocks')]: blockNames,
                };
                if (added.length) after[say('m33w.field.added')] = added;
                if (bind) after[say('m33w.field.binding')] = bindWord(say, bind, character);
                if (select && !bind) after[say('m33w.field.select')] = say('m33w.create.selectNow');
                return {
                    summary: say('m33w.create.summary', { name, count: blockNames.length, base: baseWord }),
                    target: say('m33w.target.presets'),
                    before: null,
                    after,
                    full: true,
                    async apply() {
                        const live = requireApis(app, say);
                        const create = live.store.createFromBody;
                        if (typeof create !== 'function') throw failure(say, 'presetUnavailable');
                        const result = await grouped(
                            app,
                            () => say('m33w.create.journal', { name }),
                            async () => {
                                const saved = await storeCall(say, () =>
                                    create.call(live.store, name, next, {
                                        select: select && !bind,
                                        summary: say('m33w.create.version'),
                                    }),
                                );
                                if (bind) await live.layer.bind?.(bind, saved);
                                return { preset: saved, blocks: blockNames.length, bound: bind ?? null };
                            },
                        );
                        await live.layer.flush?.();
                        return { result };
                    },
                };
            }),
    };
}

/* ------------------------------------------------------------------ bind / unbind */

function bindingPlan(
    ctx: Parameters<NonNullable<ToolSpec['plan']>>[1],
    raw: unknown,
    unbind: boolean,
): Promise<WritePlan> {
    return planWith(ctx, (say) => {
        const app = ctx.app;
        const { store, layer } = requireApis(app, say);
        if (typeof layer.bind !== 'function' || typeof layer.bindings !== 'function') {
            throw failure(say, 'presetBindUnavailable');
        }
        const args = argsOf(raw);
        const scope = reqEnum(args, 'scope', ['character', 'chat'] as const);
        const bindings = layer.bindings();
        const context = bindings.context;
        if (!context[scope]) throw failure(say, 'presetBindNoChat');
        const character = context.character?.name ?? '';
        const now = bindings[scope];
        const where = bindWord(say, scope, character);
        let preset: string | null;
        if (unbind) {
            if (!now) throw failure(say, 'presetNotBound', { where });
            preset = null;
        } else {
            const wanted = optString(args, 'preset', { max: 200 }) ?? store.current();
            preset = presetNamed(store, wanted, say);
            if (now === preset) throw failure(say, 'presetAlreadyBound', { preset, where });
        }
        const label = say(`m33w.field.bound.${scope}`);
        const none = say('m33w.bind.none');
        const summary = preset
            ? say('m33w.bind.summary', { preset, where })
            : say('m33w.unbind.summary', { preset: now ?? '', where });
        const after: Dict = { [label]: preset ?? none };
        if (preset && preset !== store.current()) after[say('m33w.field.warnings')] = [say('m33w.bind.switchNote')];
        return {
            summary,
            target: say('m33w.target.binding'),
            before: { [label]: now ?? none },
            after,
            async apply() {
                const live = requireApis(app, say);
                const bind = live.layer.bind;
                if (typeof bind !== 'function') throw failure(say, 'presetBindUnavailable');
                const result = await grouped(
                    app,
                    () => summary,
                    async () => {
                        await bind.call(live.layer, scope, preset);
                        return { scope, preset };
                    },
                );
                await live.layer.flush?.();
                return { result };
            },
        };
    });
}

const bindAvailable = (app: App) => typeof presetApis(app)?.layer.bind === 'function';

export function presetBindTool(): ToolSpec {
    return {
        name: 'preset_bind',
        kind: 'write',
        description:
            'Binds a whole preset to this character (every chat of the card) or this chat: it is selected when that ' +
            'chat opens, and the preset that was on before comes back on leaving. Default preset: the current one.',
        parameters: {
            type: 'object',
            properties: {
                scope: { type: 'string', enum: ['character', 'chat'], description: 'This character or this chat.' },
                preset: { type: 'string', description: 'The preset to bind (default: the current one).' },
            },
            required: ['scope'],
            additionalProperties: false,
        },
        available: bindAvailable,
        plan: (raw, ctx) => bindingPlan(ctx, raw, false),
    };
}

export function presetUnbindTool(): ToolSpec {
    return {
        name: 'preset_unbind',
        kind: 'write',
        description: 'Removes the preset bound to this character or this chat (the chat then uses the common preset).',
        parameters: {
            type: 'object',
            properties: {
                scope: { type: 'string', enum: ['character', 'chat'], description: 'This character or this chat.' },
            },
            required: ['scope'],
            additionalProperties: false,
        },
        available: bindAvailable,
        plan: (raw, ctx) => bindingPlan(ctx, raw, true),
    };
}

/* ------------------------------------------------------------------ save */

export function presetSaveTool(): ToolSpec {
    return {
        name: 'preset_save',
        kind: 'write',
        description:
            'Saves unsaved edits of the current preset made outside the layer (in SillyTavern’s own editor) into ' +
            'its file, or with `as_name` saves the preset as it works now under a new name and switches to it. ' +
            'Edits made by the assistant are saved by «Apply» already and need no save.',
        parameters: {
            type: 'object',
            properties: {
                as_name: { type: 'string', description: 'Save a copy under this new name instead.' },
            },
            additionalProperties: false,
        },
        available: (app) => presetStore(app) !== null,
        plan: (raw, ctx) =>
            planWith(ctx, (say): WritePlan => {
                const app = ctx.app;
                const store = presetStore(app);
                if (!store) throw failure(say, 'presetUnavailable');
                const current = store.current();
                if (!current) throw failure(say, 'presetNone');
                const args = argsOf(raw);
                const asName = optString(args, 'as_name', { max: 100 });
                if (asName) {
                    if (names(store).some((item) => item.toLowerCase() === asName.toLowerCase())) {
                        throw failure(say, 'presetExists', { preset: asName });
                    }
                    const summary = say('m33w.save.as.summary', { preset: current, name: asName });
                    return {
                        summary,
                        target: say('m33w.target.presets'),
                        before: null,
                        after: { [say('m33w.field.name')]: asName, [say('m33w.field.base')]: current },
                        async apply() {
                            const live = presetStore(app);
                            if (!live) throw failure(say, 'presetUnavailable');
                            const saved = await grouped(
                                app,
                                () => summary,
                                () => storeCall(say, () => live.saveAs(asName)),
                            );
                            return { result: { preset: saved } };
                        },
                    };
                }
                const draft = store.draft();
                if (!draft.dirty) throw failure(say, 'presetNothingToSave', { preset: current });
                const label = say('m33w.field.unsaved');
                const summary = say('m33w.save.summary', { preset: current });
                return {
                    summary,
                    target: say('m33w.target.preset', { preset: current }),
                    before: {
                        [label]: say('m33w.save.unsaved', {
                            blocks: draft.changedPrompts.length,
                            params: draft.changedKeys.length,
                        }),
                    },
                    after: { [label]: say('m33w.save.saved') },
                    async apply() {
                        const live = presetStore(app);
                        if (!live) throw failure(say, 'presetUnavailable');
                        if (live.current() !== current) {
                            throw failure(say, 'presetChanged', { preset: current, current: live.current() });
                        }
                        await grouped(
                            app,
                            () => summary,
                            () => storeCall(say, () => live.save(current, say('m33w.save.version'))),
                        );
                        await presetApis(app)?.layer.flush?.();
                        return { result: { preset: current, saved: true } };
                    },
                };
            }),
    };
}

/* ------------------------------------------------------------------ version restore */

export function presetVersionRestoreTool(): ToolSpec {
    return {
        name: 'preset_version_restore',
        kind: 'write',
        description:
            'Brings a preset file back to one of its saved versions (ids from preset_versions). The state before it ' +
            'stays as a version too; unsaved edits of the current preset are kept as a draft version.',
        parameters: {
            type: 'object',
            properties: {
                preset: { type: 'string', description: 'The preset (default: the current one).' },
                version: { type: 'string', description: 'Version id from preset_versions.' },
            },
            required: ['version'],
            additionalProperties: false,
        },
        available: (app) => presetStore(app) !== null,
        plan: (raw, ctx) =>
            planWith(ctx, async (say): Promise<WritePlan> => {
                const app = ctx.app;
                const store = presetStore(app);
                if (!store) throw failure(say, 'presetUnavailable');
                const args = argsOf(raw);
                const wanted = optString(args, 'preset', { max: 200 }) ?? store.current();
                const preset = presetNamed(store, wanted, say);
                const id = reqString(args, 'version', { max: 200 });
                const versions = await storeCall(say, () => store.versions(preset));
                const version = versions.find((item) => item.id === id);
                if (!version) throw failure(say, 'presetNoVersion', { preset, version: id });
                const date = new Date(version.at).toLocaleString(ctx.locale === 'ru' ? 'ru-RU' : 'en-GB');
                const summary = say('m33w.restore.summary', { preset, date });
                const warnings: string[] = [];
                if (preset === store.current() && store.draft().dirty) warnings.push(say('m33w.restore.draftKept'));
                const after: Dict = {
                    [say('m33w.field.version')]: date,
                    [say('m33w.field.what')]: version.summary,
                };
                if (warnings.length) after[say('m33w.field.warnings')] = warnings;
                return {
                    summary,
                    target: say('m33w.target.preset', { preset }),
                    before: { [say('m33w.field.version')]: say('m33w.restore.now') },
                    after,
                    async apply() {
                        const live = presetStore(app);
                        if (!live) throw failure(say, 'presetUnavailable');
                        await grouped(
                            app,
                            () => summary,
                            () => storeCall(say, () => live.restoreVersion(preset, id)),
                        );
                        return { result: { preset, version: id } };
                    },
                };
            }),
    };
}

/** The tools over whole presets, in the order they are offered. */
export function presetFileTools(): ToolSpec[] {
    return [presetCreateTool(), presetBindTool(), presetUnbindTool(), presetSaveTool(), presetVersionRestoreTool()];
}
