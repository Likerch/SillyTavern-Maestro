// Write tools over the chat preset (M33 over M34, plan-2 §1 «Ассистент работает с пресетами»): blocks — add, edit
// (text whole or by exact replacements, name, role, place in the list or in the chat, depth, order), condition,
// switch on/off, move, remove — and generation parameters; several related edits as one pack. Every change goes to the
// layer of the chosen scope («Везде» by default, «Этот персонаж», «Этот чат»; the card can switch it) and then to the
// working copy (preset-changes.ts); the preset file is never written and «Применить» needs no save step. The edits of
// one card are journaled by the Preset Studio one by one; the card adds one record over them, so one undo takes the
// card back (common.ts grouped()).
import { ArgError, isDict } from '../../../../domain/assistant-write-args';
import type { Dict } from '../../../../domain/assistant-write-args';
import { BLOCK_PLACES, CONDITION_MODES } from '../../../../domain/assistant-write-preset';
import { ORDER_PLACES } from '../../../../domain/assistant-write-presets';
import { PROMPT_ROLES } from '../../../../domain/preset-ui-blocks';
import type { App } from '../../../../shared/contracts';
import type { LayerScope } from '../../../presetStudio/layer-api';
import type { ApplyChoice, ToolContext, ToolSpec, WriteOutcome, WritePlan, WritePlanItem } from '../../api';
import { activeQuirks, availableScopes, isScope, presetApis, scopeChoices } from '../preset-common';
import { argsOf, failure, grouped, planWith } from './common';
import {
    addChanges,
    conditionChanges,
    editChanges,
    moveChanges,
    paramChanges,
    removeChanges,
    scopeArg,
    toggleChanges,
} from './preset-changes';
import type { ChangeBuilder, ChangeContext, PresetChange } from './preset-changes';
import type { Say } from './strings';

/** Most changes in one pack (the message's limit is 20 in all). */
export const MAX_PACK = 20;

/** The scope property every preset write tool takes. */
export const SCOPE_PROPERTY = {
    type: 'string',
    enum: ['global', 'character', 'chat'],
    description:
        'Where the change works: global (everywhere, the default), character (every chat of this character card) or ' +
        'chat (this chat only). Give it only when the user asked for this character or this chat; he can switch it ' +
        'on the card. A block the layer added is always changed in its own scope.',
} as const;

const BLOCK_PROPERTY = { type: 'string', description: 'Identifier or name of the block (see preset_blocks).' };

/** The changes a pack item or a tool call may build, by tool name. */
const BUILDERS: Readonly<Record<string, ChangeBuilder>> = {
    preset_block_add: addChanges,
    preset_block_condition: conditionChanges,
    preset_block_edit: editChanges,
    preset_block_toggle: toggleChanges,
    preset_block_move: moveChanges,
    preset_block_remove: removeChanges,
    preset_params_set: paramChanges,
};

export const PACK_TOOLS = Object.keys(BUILDERS);

function changeContext(ctx: ToolContext, say: Say): ChangeContext {
    const apis = presetApis(ctx.app);
    if (!apis) throw failure(say, 'presetUnavailable');
    const base = apis.store.current();
    if (!base) throw failure(say, 'presetNone');
    return { app: ctx.app, apis, say, base, quirks: activeQuirks(ctx.app) };
}

/** The scope the user picked on the card (one the chat offers now), else the change's own. */
function chosenScope(
    change: { scope: LayerScope; fixed: boolean },
    choice: ApplyChoice | undefined,
    app: App,
): LayerScope {
    if (change.fixed) return change.scope;
    const wanted = choice?.scope;
    if (!isScope(wanted)) return change.scope;
    return availableScopes(presetApis(app)?.layer ?? null).includes(wanted) ? wanted : change.scope;
}

async function flushLayer(app: App): Promise<void> {
    try {
        await presetApis(app)?.layer.flush?.();
    } catch (error) {
        app.log.warn('assistant: the preset layer was not written at once', error);
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** One change as a card. */
export function singlePlan(cc: ChangeContext, change: PresetChange): WritePlan {
    const { app, say } = cc;
    return {
        summary: change.summary,
        target: change.target,
        before: change.before,
        after: change.after,
        scope: change.scope,
        scopes: scopeChoices(say, cc.apis.layer, change.fixed ? change.scope : null),
        full: change.full,
        async apply(choice) {
            const scope = chosenScope(change, choice, app);
            const result = await grouped(
                app,
                () => say('m33w.preset.journal.one', { summary: change.summary }),
                () => change.apply(scope),
            );
            await flushLayer(app);
            return { result };
        },
    };
}

/** Several changes as one card with a tick per change; applied in order, one journal group, one undo. */
export function packPlan(cc: ChangeContext, changes: PresetChange[], summary: string, scope: LayerScope): WritePlan {
    const { app, say } = cc;
    if (!changes.length) throw new ArgError('argMissing', { name: 'changes' });
    if (changes.length > MAX_PACK) throw failure(say, 'presetPackTooBig', { count: changes.length, max: MAX_PACK });
    const keys = new Set<string>();
    for (const change of changes) {
        if (keys.has(change.key)) throw failure(say, 'presetPackTwice', { summary: change.summary });
        keys.add(change.key);
    }
    const packTarget = say('m33w.target.preset', { preset: cc.base });
    const items: WritePlanItem[] = changes.map((change, index) => {
        const item: WritePlanItem = {
            id: `c${index + 1}`,
            summary: change.summary,
            before: change.before,
            after: change.after,
        };
        if (change.target !== packTarget) item.target = change.target;
        return item;
    });
    const title = summary || changes.map((change) => change.summary).join('; ');
    return {
        summary: say('m33w.pack.summary', { count: changes.length, summary: title }),
        target: packTarget,
        before: undefined,
        after: undefined,
        items,
        scope,
        scopes: scopeChoices(say, cc.apis.layer),
        full: true,
        async apply(choice): Promise<WriteOutcome> {
            const selected = new Set(choice?.selected ?? items.map((item) => item.id));
            const fates: NonNullable<WriteOutcome['items']> = [];
            const picked = isScope(choice?.scope) ? choice.scope : scope;
            await grouped(
                app,
                () =>
                    say('m33w.preset.journal.pack', {
                        preset: cc.base,
                        count: fates.filter((f) => f.status === 'applied').length,
                    }),
                async () => {
                    for (const [index, change] of changes.entries()) {
                        const id = items[index]!.id;
                        if (!selected.has(id)) {
                            fates.push({ id, status: 'skipped' });
                            continue;
                        }
                        try {
                            await change.apply(chosenScope(change, { scope: picked }, app));
                            fates.push({ id, status: 'applied' });
                        } catch (error) {
                            fates.push({ id, status: 'error', error: errorText(error) });
                        }
                    }
                },
            );
            await flushLayer(app);
            return {
                items: fates,
                result: { preset: cc.base, applied: fates.filter((f) => f.status === 'applied').length },
            };
        },
    };
}

/** A tool over one builder: one change → one card, several (a list of blocks or parameters) → a pack. */
function builderTool(spec: Omit<ToolSpec, 'kind' | 'plan' | 'available'>, build: ChangeBuilder): ToolSpec {
    return {
        ...spec,
        kind: 'write',
        available: (app) => presetApis(app) !== null,
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const cc = changeContext(ctx, say);
                const args = argsOf(raw);
                const scope = scopeArg(cc, args, availableScopes(cc.apis.layer));
                const changes = build(cc, args, scope);
                if (changes.length === 1) return singlePlan(cc, changes[0]!);
                return packPlan(cc, changes, '', scope);
            }),
    };
}

/* ------------------------------------------------------------------ the tools */

export function presetBlockAddTool(): ToolSpec {
    return builderTool(
        {
            name: 'preset_block_add',
            description:
                'Adds a new prompt block to the layer of the current Chat Completion preset (the base preset file is ' +
                'never changed; the layer survives preset updates). position.place: start, end, after or before ' +
                '(position.block: the identifier or name of a block in the prompt list); position.depth puts it into ' +
                'the chat at that depth. condition: send the block only when a Maestro flag is set (mode "only") or ' +
                'except then ("except"), e.g. maestro_scene_combat. Blocks and the flag catalogue: preset_blocks.',
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
                    scope: SCOPE_PROPERTY,
                },
                required: ['name', 'content', 'position'],
                additionalProperties: false,
            },
        },
        addChanges,
    );
}

export function presetBlockConditionTool(): ToolSpec {
    return builderTool(
        {
            name: 'preset_block_condition',
            description:
                'Puts a condition on a block of the current preset, recorded in the layer (the base file is never ' +
                'changed): mode "only" sends it only when the flag is set, "except" only when it is not, "always" ' +
                "removes the block's condition. The flag is a Maestro flag such as maestro_scene_combat (the " +
                "director's and the mechanics' catalogue, or a maestro_… name).",
            parameters: {
                type: 'object',
                properties: {
                    block: BLOCK_PROPERTY,
                    flag: { type: 'string', description: 'Flag name, e.g. maestro_scene_combat (not for always).' },
                    mode: { type: 'string', enum: [...CONDITION_MODES], description: 'only, except, or always.' },
                    scope: SCOPE_PROPERTY,
                },
                required: ['block', 'mode'],
                additionalProperties: false,
            },
        },
        conditionChanges,
    );
}

export function presetBlockEditTool(): ToolSpec {
    return builderTool(
        {
            name: 'preset_block_edit',
            description:
                'Edits a block of the current preset in the layer: its text (`content`: the whole new text, or ' +
                '`replace`: exact snippets to swap — each `find` must occur once; better for long blocks), name, ' +
                'role, placement (list = in the prompt order, chat = inside the chat history at `depth`) and the ' +
                'order among in-chat blocks. Read the block first (preset_block_read). The card shows a word diff ' +
                'of the whole text.',
            parameters: {
                type: 'object',
                properties: {
                    block: BLOCK_PROPERTY,
                    content: { type: 'string', description: 'The whole new text of the block.' },
                    replace: {
                        type: 'array',
                        description: 'Instead of content: [{find, with}] exact snippets of the current text to change.',
                        items: {
                            type: 'object',
                            properties: { find: { type: 'string' }, with: { type: 'string' } },
                            required: ['find', 'with'],
                            additionalProperties: false,
                        },
                    },
                    name: { type: 'string', description: 'New block name.' },
                    role: { type: 'string', enum: [...PROMPT_ROLES], description: 'New message role.' },
                    placement: {
                        type: 'string',
                        enum: ['list', 'chat'],
                        description: 'list: in the prompt order; chat: inside the chat history at a depth.',
                    },
                    depth: { type: 'integer', description: 'In-chat depth (0 = after the last message).' },
                    order: { type: 'integer', description: 'Order among in-chat blocks at the same depth (100).' },
                    scope: SCOPE_PROPERTY,
                },
                required: ['block'],
                additionalProperties: false,
            },
        },
        editChanges,
    );
}

export function presetBlockToggleTool(): ToolSpec {
    return builderTool(
        {
            name: 'preset_block_toggle',
            description:
                'Switches blocks of the current preset on or off in the layer. `block` for one, `blocks` for several ' +
                '(they come as one pack card). Chat History always stays on.',
            parameters: {
                type: 'object',
                properties: {
                    block: BLOCK_PROPERTY,
                    blocks: { type: 'array', items: { type: 'string' }, description: 'Several blocks at once.' },
                    enabled: { type: 'boolean', description: 'true switches on, false off.' },
                    scope: SCOPE_PROPERTY,
                },
                required: ['enabled'],
                additionalProperties: false,
            },
        },
        toggleChanges,
    );
}

export function presetBlockMoveTool(): ToolSpec {
    return builderTool(
        {
            name: 'preset_block_move',
            description:
                'Moves a block within the prompt order of the current preset (in the layer): to the start, the ' +
                'end, or after / before another block (`anchor`). For the place inside the chat history use ' +
                'preset_block_edit (placement chat, depth).',
            parameters: {
                type: 'object',
                properties: {
                    block: BLOCK_PROPERTY,
                    place: { type: 'string', enum: [...ORDER_PLACES], description: 'start, end, after or before.' },
                    anchor: { type: 'string', description: 'The block to go after or before (identifier or name).' },
                    scope: SCOPE_PROPERTY,
                },
                required: ['block', 'place'],
                additionalProperties: false,
            },
        },
        moveChanges,
    );
}

export function presetBlockRemoveTool(): ToolSpec {
    return builderTool(
        {
            name: 'preset_block_remove',
            description:
                'Removes a block from the current preset through the layer: a block the layer added is deleted; a ' +
                'block of the base preset is switched off in the layer (the base file keeps it, so it can come back).',
            parameters: {
                type: 'object',
                properties: { block: BLOCK_PROPERTY, scope: SCOPE_PROPERTY },
                required: ['block'],
                additionalProperties: false,
            },
        },
        removeChanges,
    );
}

export function presetParamsSetTool(): ToolSpec {
    return builderTool(
        {
            name: 'preset_params_set',
            description:
                'Sets generation parameters of the current preset in the layer: {"temperature": 0.9, "top_p": 0.95, ' +
                '"openai_max_tokens": 1200, "reasoning_effort": "low", …} by preset key (see preset_params). Values ' +
                "are checked against SillyTavern's limits. Connection settings, models, addresses and keys cannot " +
                'be set. Several parameters come as one pack card.',
            parameters: {
                type: 'object',
                properties: {
                    params: { type: 'object', description: 'Preset key → new value.' },
                    scope: SCOPE_PROPERTY,
                },
                required: ['params'],
                additionalProperties: false,
            },
        },
        paramChanges,
    );
}

export function presetPackTool(): ToolSpec {
    return {
        name: 'preset_pack',
        kind: 'write',
        description:
            'Several related edits of the current preset as ONE card (a pack): the user can untick changes, apply ' +
            'all or the selected ones, and undo the pack at once. Each change is {tool, args} with the arguments of ' +
            `that tool (${PACK_TOOLS.join(', ')}; their own scope argument is ignored: the pack has one). At most ` +
            `${MAX_PACK} changes; one change per block and kind.`,
        parameters: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'What the pack does, one short line in the user’s language.' },
                changes: {
                    type: 'array',
                    description: 'The changes: [{tool, args}].',
                    items: {
                        type: 'object',
                        properties: {
                            tool: { type: 'string', enum: PACK_TOOLS },
                            args: { type: 'object' },
                        },
                        required: ['tool', 'args'],
                        additionalProperties: false,
                    },
                },
                scope: SCOPE_PROPERTY,
            },
            required: ['changes'],
            additionalProperties: false,
        },
        available: (app) => presetApis(app) !== null,
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const cc = changeContext(ctx, say);
                const args = argsOf(raw);
                const scope = scopeArg(cc, args, availableScopes(cc.apis.layer));
                const list = args.changes;
                if (!Array.isArray(list) || !list.length) throw new ArgError('argMissing', { name: 'changes' });
                if (list.length > MAX_PACK)
                    throw failure(say, 'presetPackTooBig', { count: list.length, max: MAX_PACK });
                const changes: PresetChange[] = [];
                list.forEach((item, index) => {
                    if (!isDict(item) || typeof item.tool !== 'string' || !BUILDERS[item.tool]) {
                        throw failure(say, 'presetPackTool', { index: index + 1, tools: PACK_TOOLS.join(', ') });
                    }
                    const itemArgs: Dict = isDict(item.args) ? { ...item.args } : {};
                    delete itemArgs.scope;
                    try {
                        changes.push(...BUILDERS[item.tool]!(cc, itemArgs, scope));
                    } catch (error) {
                        // Which change of the pack failed, in the user's words.
                        const message =
                            error instanceof ArgError
                                ? failure(say, error.code, error.params).message
                                : errorText(error);
                        throw new Error(say('m33w.err.presetPackItem', { index: index + 1, error: message }), {
                            cause: error,
                        });
                    }
                });
                const summary = typeof args.summary === 'string' ? args.summary.trim().slice(0, 200) : '';
                return packPlan(cc, changes, summary, scope);
            }),
    };
}

/** The preset write tools over the layer, in the order they are offered. */
export function presetWriteTools(): ToolSpec[] {
    return [
        presetBlockAddTool(),
        presetBlockConditionTool(),
        presetBlockEditTool(),
        presetBlockToggleTool(),
        presetBlockMoveTool(),
        presetBlockRemoveTool(),
        presetParamsSetTool(),
        presetPackTool(),
    ];
}
