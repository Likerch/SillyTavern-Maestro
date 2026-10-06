// Read tools over the chat preset (M33 over M34/M36, plan-2 §1 п. 1 and п. 6): the presets and their bindings, a block
// whole (with the scopes of the layer that changed it), the generation parameters (connection settings, addresses and
// keys never), the studio's analysis and the model's quirks, two presets compared, the saved versions, a dry run of
// the prompt (the studio's map, the conditions resolved with the flags set now and macros filled in — nothing is sent
// to a model, lore, card and history only as sizes), and the other extensions' prompts. Block texts are other people's
// content: every answer that carries them is untrusted data. Long texts are fitted to the result size.
// The dry run does not start ST's own dry-run generation: the host does not expose it, and it would run every
// extension's generation listeners (P-007: the studio never assembles more often than Prompt Manager does); the map
// uses ST's token counts of the last real assembly where Maestro cannot know a text (lore, card, history).
import { dryRunView, paramsView } from '../../../../domain/assistant-preset-read';
import type { DrySlot } from '../../../../domain/assistant-preset-read';
import { isHiddenParam } from '../../../../domain/assistant-write-presets';
import { comparePresets, MASKED } from '../../../../domain/preset-compare';
import { blockCondition, evaluate } from '../../../../domain/preset-conditional-syntax';
import type { LayerBody } from '../../../../domain/preset-layer-apply';
import {
    isInChat,
    isMarker,
    promptDepth,
    promptName,
    promptOrder,
    promptRole,
    promptText,
    promptTriggers,
    PROMPT_TRIGGERS,
    sideEffectMacros,
} from '../../../../domain/preset-ui-blocks';
import type { App } from '../../../../shared/contracts';
import type { DirectorApi } from '../../../director/api';
import type { NeighbourPrompt } from '../../../neighbourPrompts/api';
import type { ScopedLayerOp } from '../../../presetStudio/layer-api';
import type { PresetBody, PresetStore } from '../../../presetStudio/store-api';
import type { ToolContext, ToolSpec } from '../../api';
import {
    bodyRows,
    layerOps,
    lookupBlock,
    neighbourPrompts,
    opTarget,
    presetAnalysis,
    presetLayer,
    presetStore,
    scopeContext,
    workingRows,
} from '../preset-common';
import type { BlockRow } from '../preset-common';
import {
    apiOf,
    argsOf,
    boolArg,
    capList,
    compact,
    cut,
    enumArg,
    fitToSize,
    intArg,
    needsApi,
    notice,
    objectSchema,
    prop,
    readTool,
    safely,
    say,
    strArg,
    when,
    withTimeout,
} from './common';
import type { Dict } from './common';

/** Room the wrapper and the other fields of an answer need besides the long texts. */
const OVERHEAD = 1500;

function budget(ctx: ToolContext): number {
    return Math.max(2000, (ctx.resultChars ?? 12000) - OVERHEAD);
}

const off = (ctx: ToolContext) => notice(ctx, 'The Preset Studio is off.', 'Пресет-студия выключена.');

const PRESET_ARG = prop.string('Another saved preset by name (default: the current one, as it works now).');

/** The rows of the preset asked for: the working copy of the current one, else the saved body of another. */
function rowsFor(
    store: PresetStore,
    wanted: string | undefined,
): { preset: string; rows: BlockRow[]; body: PresetBody } | null {
    const current = safely(() => store.current(), '');
    if (!wanted || wanted === current) {
        const body = safely(() => store.working(), {} as PresetBody);
        return { preset: current, rows: workingRows(store), body };
    }
    const names = safely(() => store.names(), [] as string[]);
    const name = names.includes(wanted) ? wanted : names.find((item) => item.toLowerCase() === wanted.toLowerCase());
    if (!name) return null;
    const body = safely(() => store.saved(name), null);
    return body ? { preset: name, rows: bodyRows(body), body } : null;
}

function scopeCounts(ops: readonly ScopedLayerOp[]): Dict {
    const counts: Dict = { global: 0, character: 0, chat: 0 };
    for (const op of ops) counts[op.scope ?? 'global'] = (counts[op.scope ?? 'global'] as number) + 1;
    return counts;
}

/** What an op of the layer does to a block, in a few English words for the model. */
function opWords(op: ScopedLayerOp): string {
    switch (op.op) {
        case 'add':
            return 'added by the layer';
        case 'edit':
            return `edited (${Object.keys(op.patch).join(', ')})`;
        case 'toggle':
            return op.enabled ? 'switched on' : 'switched off';
        case 'move':
            return 'moved';
        default:
            return `parameter ${op.key}`;
    }
}

/* ------------------------------------------------------------------ preset_list */

const presetList = (app: App): ToolSpec =>
    readTool({
        name: 'preset_list',
        description:
            'Chat Completion presets: the current one, every saved preset, the presets bound to this character and ' +
            'this chat, unsaved edits of the current preset (made outside the layer), the layer edits laid over it ' +
            'by scope (global = everywhere, character = this character, chat = this chat) and conflicts with a ' +
            'changed base. Start here for preset work.',
        parameters: objectSchema(),
        available: needsApi('presetStore'),
        async run(_rawArgs, ctx) {
            const store = presetStore(app);
            if (!store) return off(ctx);
            const layer = presetLayer(app);
            const current = safely(() => store.current(), '');
            const names = safely(() => store.names(), [] as string[]);
            const draft = safely(() => store.draft(), null);
            const bindings = layer ? safely(() => layer.bindings?.() ?? null, null) : null;
            const context = scopeContext(layer);
            const report = layer ? safely(() => layer.lastReport(), null) : null;
            const list = capList(names, 100);
            return {
                data: compact({
                    current,
                    presets: list.items,
                    morePresets: list.more,
                    unsaved: draft?.dirty
                        ? { blocks: draft.changedPrompts.length, parameters: draft.changedKeys.length }
                        : false,
                    bound: bindings ? { character: bindings.character, chat: bindings.chat } : undefined,
                    scopes: {
                        character: context?.character?.name ?? null,
                        chatOpen: !!context?.chat,
                    },
                    layerEdits: layer ? scopeCounts(layerOps(layer, current)) : undefined,
                    conflicts: report?.conflicts.length || undefined,
                    orphaned: report?.orphaned.length || undefined,
                }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Presets: ${names.length}, current «${current}»`,
                    `Пресеты: ${names.length}, текущий «${current}»`,
                ),
            };
        },
    });

/* ------------------------------------------------------------------ preset_block_read */

const presetBlockRead = (app: App): ToolSpec =>
    readTool({
        name: 'preset_block_read',
        description:
            'One block of a preset whole: its full text (long texts in parts: pass `offset` from `nextOffset`), ' +
            'role, place (in the prompt list, or in the chat at a depth), order, on/off, generation types, its ' +
            'condition, and which scope of the layer changed it (global / character / chat). `with_base` adds the ' +
            'text of the base preset when the layer edited it.',
        parameters: objectSchema(
            {
                block: prop.string('Identifier or name of the block.'),
                preset: PRESET_ARG,
                offset: prop.integer('Where to continue a long text (nextOffset of the previous answer).'),
                with_base: prop.boolean('Also the base text when the layer edited the block.'),
            },
            ['block'],
        ),
        available: needsApi('presetStore'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const store = presetStore(app);
            if (!store) return off(ctx);
            const wanted = strArg(args, 'block', 200);
            if (!wanted) return notice(ctx, 'Name a block.', 'Укажи блок.');
            const found = rowsFor(store, strArg(args, 'preset', 200));
            if (!found) return notice(ctx, 'There is no such preset.', 'Такого пресета нет.');
            const lookup = lookupBlock(found.rows, wanted);
            if (!('row' in lookup)) {
                return notice(
                    ctx,
                    lookup.problem === 'ambiguous'
                        ? 'Several blocks have this name: use the identifier.'
                        : 'No such block.',
                    lookup.problem === 'ambiguous'
                        ? 'Блоков с таким названием несколько — укажи идентификатор.'
                        : 'Такого блока нет.',
                    { blocks: found.rows.slice(0, 60).map((row) => `${promptName(row.prompt)} (${row.identifier})`) },
                );
            }
            const { row } = lookup;
            const prompt = row.prompt;
            const text = promptText(prompt);
            const room = budget(ctx);
            const offset = Math.min(Math.max(0, intArg(args, 'offset', 0, 0, 10_000_000)), text.length);
            const withBase = boolArg(args, 'with_base', false);
            const layer = presetLayer(app);
            const ops = layer ? layerOps(layer, found.preset).filter((op) => opTarget(op) === row.identifier) : [];
            const edited = ops.some((op) => op.op === 'edit');
            const baseText =
                withBase && edited
                    ? promptText(
                          bodyRows(safely(() => store.saved(found.preset), null) ?? {}).find(
                              (item) => item.identifier === row.identifier,
                          )?.prompt ?? { identifier: row.identifier },
                      )
                    : undefined;
            const share = baseText !== undefined ? Math.floor(room / 2) : room;
            const slice = text.slice(offset, offset + share);
            const end = offset + slice.length;
            const condition = blockCondition(text);
            const marker = isMarker(prompt);
            return {
                data: compact({
                    preset: found.preset,
                    identifier: row.identifier,
                    name: promptName(prompt),
                    kind: marker ? 'filled by SillyTavern (card, lore, history…)' : 'preset block',
                    role: promptRole(prompt),
                    placement: isInChat(prompt) ? 'in the chat' : 'in the prompt list',
                    depth: isInChat(prompt) ? promptDepth(prompt) : undefined,
                    order: isInChat(prompt) ? promptOrder(prompt) : undefined,
                    enabled: row.enabled === null ? 'not in the prompt list' : row.enabled,
                    position: row.index >= 0 ? row.index + 1 : undefined,
                    onlyFor: promptTriggers(prompt).length ? promptTriggers(prompt) : undefined,
                    condition: condition
                        ? `${condition.negate ? 'except when' : 'only when'} ${condition.flag}`
                        : undefined,
                    chars: text.length,
                    text: marker && !text ? undefined : slice,
                    from: offset || undefined,
                    nextOffset: end < text.length ? end : undefined,
                    layer: ops.length
                        ? ops.map((op) => ({ scope: op.scope ?? 'global', change: opWords(op) }))
                        : undefined,
                    baseText: baseText === undefined ? undefined : cut(baseText, share),
                }),
                untrusted: true,
                summary: say(ctx, `Block «${promptName(prompt)}»`, `Блок «${promptName(prompt)}»`),
            };
        },
    });

/* ------------------------------------------------------------------ preset_params */

const presetParams = (app: App): ToolSpec =>
    readTool({
        name: 'preset_params',
        description:
            'Generation parameters of a preset by preset key (temperature, top_p, top_k, penalties, openai_max_tokens, ' +
            'openai_max_context, reasoning_effort, show_thoughts, assistant_prefill, utility prompts…) and the ' +
            'layer edits of them by scope. Connection settings (source, models, addresses, keys) stay hidden.',
        parameters: objectSchema({ preset: PRESET_ARG }),
        available: needsApi('presetStore'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const store = presetStore(app);
            if (!store) return off(ctx);
            const found = rowsFor(store, strArg(args, 'preset', 200));
            if (!found) return notice(ctx, 'There is no such preset.', 'Такого пресета нет.');
            const view = paramsView(found.body);
            const layer = presetLayer(app);
            const keys = layer
                ? layerOps(layer, found.preset)
                      .filter((op) => op.op === 'key' && !isHiddenParam(op.key))
                      .map((op) => ({ key: op.op === 'key' ? op.key : '', scope: op.scope ?? 'global' }))
                : [];
            return {
                data: compact({
                    preset: found.preset,
                    params: view.params,
                    other: Object.keys(view.other).length ? view.other : undefined,
                    hiddenConnectionSettings: view.hidden || undefined,
                    layerEdits: keys.length ? keys : undefined,
                }),
                untrusted: true,
                summary: say(ctx, `Parameters of «${found.preset}»`, `Параметры «${found.preset}»`),
            };
        },
    });

/* ------------------------------------------------------------------ preset_findings */

const TYPE_ARG = prop.enum('Generation type (default normal): blocks can be limited to types.', PROMPT_TRIGGERS);

const presetFindings = (app: App): ToolSpec =>
    readTool({
        name: 'preset_findings',
        description:
            "The Preset Studio's analysis of the current preset: blocks that never go out, wrong types, " +
            'contradictions, repeats of lore or of extension prompts, duplicate and heavy blocks, unsaved edits, ' +
            '{{if}} without the new macro engine, empty messages, quirks of the active model; plus hints for the ' +
            'model and provider (reasoning, prefill, temperature).',
        parameters: objectSchema({ type: TYPE_ARG }),
        available: needsApi('presetAnalysis'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const analysis = presetAnalysis(app);
            const store = presetStore(app);
            if (!analysis || !store) return off(ctx);
            const type = enumArg(args, 'type', PROMPT_TRIGGERS, 'normal');
            const findings = await withTimeout(analysis.findings(undefined, { type }), 20_000, null);
            if (!findings) return notice(ctx, 'The analysis took too long.', 'Анализ не уложился во время.');
            const names = new Map(workingRows(store).map((row) => [row.identifier, promptName(row.prompt)]));
            const list = capList(
                findings.map((finding) =>
                    compact({
                        kind: finding.kind,
                        severity: finding.severity,
                        block: finding.identifier ? (names.get(finding.identifier) ?? finding.identifier) : undefined,
                        other: finding.otherIdentifier
                            ? (names.get(finding.otherIdentifier) ?? finding.otherIdentifier)
                            : undefined,
                        text: cut(finding.text, 400),
                    }),
                ),
                40,
            );
            const hints = safely(() => analysis.hints(), []).map((hint) => ({
                model: hint.model,
                text: cut(hint.text, 400),
            }));
            return {
                data: compact({
                    preset: safely(() => store.current(), undefined),
                    findings: list.items,
                    more: list.more,
                    hints: hints.length ? hints : undefined,
                }),
                untrusted: true,
                summary: say(ctx, `Findings: ${findings.length}`, `Находки: ${findings.length}`),
            };
        },
    });

/* ------------------------------------------------------------------ preset_compare */

const WORKING = 'working';

const presetCompare = (app: App): ToolSpec =>
    readTool({
        name: 'preset_compare',
        description:
            'Compares two presets (saved names; "working" = the current preset as it works now): blocks only one ' +
            'has, blocks with different fields, blocks switched on in one and off in the other, the order, and ' +
            'different parameters (connection settings masked). `block` adds both texts of one block.',
        parameters: objectSchema(
            {
                a: prop.string('First preset (name, or "working").'),
                b: prop.string('Second preset (name, or "working").'),
                block: prop.string('Also both texts of this block (identifier or name).'),
            },
            ['a', 'b'],
        ),
        available: needsApi('presetStore'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const store = presetStore(app);
            if (!store) return off(ctx);
            const bodyOf = (name: string | undefined): { name: string; body: PresetBody } | null => {
                if (!name) return null;
                if (name === WORKING) return { name, body: safely(() => store.working(), {} as PresetBody) };
                const found = rowsFor(store, name);
                if (!found) return null;
                return found.preset === safely(() => store.current(), '')
                    ? { name: found.preset, body: safely(() => store.saved(found.preset), null) ?? found.body }
                    : { name: found.preset, body: found.body };
            };
            const a = bodyOf(strArg(args, 'a', 200));
            const b = bodyOf(strArg(args, 'b', 200));
            if (!a || !b) return notice(ctx, 'One of the presets does not exist.', 'Одного из пресетов нет.');
            const result = comparePresets(a.body as LayerBody, b.body as LayerBody);
            const mask = (key: string, value: unknown) => (isHiddenParam(key) && value !== null ? MASKED : value);
            const room = budget(ctx);
            const wanted = strArg(args, 'block', 200);
            let block: Dict | undefined;
            if (wanted) {
                const rowA = lookupBlock(bodyRows(a.body), wanted);
                const rowB = lookupBlock(bodyRows(b.body), wanted);
                block = {
                    a: 'row' in rowA ? cut(promptText(rowA.row.prompt), Math.floor(room / 3)) : null,
                    b: 'row' in rowB ? cut(promptText(rowB.row.prompt), Math.floor(room / 3)) : null,
                };
            }
            const changed = capList(
                result.changed.map((item) => ({ name: item.name, fields: item.fields })),
                60,
            );
            return {
                data: compact({
                    a: a.name,
                    b: b.name,
                    onlyInB: result.added.map((item) => item.name),
                    onlyInA: result.removed.map((item) => item.name),
                    changed: changed.items,
                    moreChanged: changed.more,
                    switched: result.toggled.map((item) => ({ name: item.name, a: item.a, b: item.b })),
                    reordered: result.reordered,
                    params: result.params.map((item) => ({
                        key: item.key,
                        a: mask(item.key, item.a),
                        b: mask(item.key, item.b),
                    })),
                    block,
                }),
                untrusted: true,
                summary: say(ctx, `«${a.name}» vs «${b.name}»`, `«${a.name}» и «${b.name}»`),
            };
        },
    });

/* ------------------------------------------------------------------ preset_versions */

const presetVersions = (app: App): ToolSpec =>
    readTool({
        name: 'preset_versions',
        description:
            'Saved versions of a preset file, newest first: id (for preset_version_restore), when, who saved it ' +
            '(user, layer, import, st = outside Maestro, draft = unsaved edits kept before a switch) and a summary.',
        parameters: objectSchema({ preset: PRESET_ARG }),
        available: needsApi('presetStore'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const store = presetStore(app);
            if (!store) return off(ctx);
            const found = rowsFor(store, strArg(args, 'preset', 200));
            if (!found) return notice(ctx, 'There is no such preset.', 'Такого пресета нет.');
            const versions = await withTimeout(store.versions(found.preset), 10_000, []);
            const sorted = [...versions].sort((x, y) => y.at - x.at);
            const list = capList(sorted, 30);
            return {
                data: compact({
                    preset: found.preset,
                    versions: list.items.map((version) => ({
                        id: version.id,
                        at: when(version.at),
                        by: version.by,
                        summary: cut(version.summary, 200),
                    })),
                    more: list.more,
                }),
                untrusted: true,
                summary: say(ctx, `Versions: ${versions.length}`, `Версии: ${versions.length}`),
            };
        },
    });

/* ------------------------------------------------------------------ preset_dry_run */

/** The flags Maestro sets for the next generation now (the director's and the mechanics'). */
function flagsNow(app: App): Record<string, string> {
    const flags: Record<string, string> = {};
    const director = apiOf<DirectorApi>(app, 'director');
    const values = director ? safely(() => director.flags(), {}) : {};
    for (const [name, value] of Object.entries(values)) flags[name] = String(value);
    const mechanics = apiOf<Record<string, unknown>>(app, 'mechanics');
    const on =
        mechanics && typeof mechanics.flagsOn === 'function'
            ? safely(() => (mechanics.flagsOn as () => unknown)(), [])
            : [];
    if (Array.isArray(on)) for (const name of on) if (typeof name === 'string') flags[name] = '1';
    return flags;
}

const presetDryRun = (app: App): ToolSpec =>
    readTool({
        name: 'preset_dry_run',
        description:
            'Assembles the prompt of the current preset WITHOUT sending anything to a model: what goes out in ' +
            'which order and role (blocks before, inside and after the chat history), the size of each part in ' +
            'tokens, short previews of the preset blocks (conditions resolved with the flags set now, macros ' +
            'filled in), blocks that are off or silent now. The card, lore and history only as sizes. `preset` ' +
            'dry-runs another saved preset with your layer laid over it.',
        parameters: objectSchema({
            type: TYPE_ARG,
            preset: PRESET_ARG,
            preview_chars: prop.integer('Preview length per block, characters (default 160).'),
        }),
        available: needsApi('presetAnalysis'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const analysis = presetAnalysis(app);
            const store = presetStore(app);
            if (!analysis || !store) return off(ctx);
            const type = enumArg(args, 'type', PROMPT_TRIGGERS, 'normal');
            const current = safely(() => store.current(), '');
            const wanted = strArg(args, 'preset', 200);
            let body: PresetBody | undefined;
            let rows: BlockRow[];
            let preset = current;
            if (wanted && wanted !== current) {
                const found = rowsFor(store, wanted);
                if (!found) return notice(ctx, 'There is no such preset.', 'Такого пресета нет.');
                const layer = presetLayer(app);
                body = layer ? safely(() => layer.apply(found.preset, found.body).body, found.body) : found.body;
                rows = bodyRows(body);
                preset = found.preset;
            } else {
                rows = workingRows(store);
            }
            const slots = await withTimeout(analysis.map(body, { type }), 25_000, null);
            if (!slots) return notice(ctx, 'The assembly took too long.', 'Сборка не уложилась во время.');
            const engine = safely(() => app.host.ctx().powerUserSettings?.experimental_macro_engine, undefined);
            const engineOn = engine !== false;
            const flags = flagsNow(app);
            const substitute = safely(() => app.host.ctx().substituteParams, undefined);
            const texts = new Map<string, string>();
            const silent = new Set<string>();
            const byId = new Map(rows.map((row) => [row.identifier, row.prompt]));
            for (const slot of slots) {
                const prompt = byId.get(slot.identifier);
                if (!prompt || slot.marker) continue;
                let text = promptText(prompt);
                if (engineOn) text = evaluate(text, flags);
                if (engineOn && promptText(prompt).trim() && !text.trim()) {
                    silent.add(slot.identifier);
                    continue;
                }
                // Macros with side effects (setvar…) are left as written: a preview must not run them.
                if (typeof substitute === 'function' && !sideEffectMacros(text).length) {
                    text = safely(() => substitute(text), text);
                }
                texts.set(slot.identifier, text);
            }
            const preview = intArg(args, 'preview_chars', 160, 40, 600);
            const fitted = fitToSize(
                (scale) =>
                    dryRunView({
                        slots: slots as DrySlot[],
                        texts,
                        silent,
                        previewChars: Math.round(preview * scale),
                    }),
                budget(ctx),
            );
            const view = fitted.data;
            return {
                data: compact({
                    preset,
                    type,
                    sent: false,
                    macroEngine: engine === false ? 'off: {{if}} and its branches go to the model as text' : 'on',
                    flagsNow: Object.keys(flags).length ? Object.keys(flags) : undefined,
                    tokens: view.tokens,
                    messages: view.messages,
                    notSent: view.notSent.length ? view.notSent : undefined,
                    note:
                        'Assembled without sending. Sizes are tokens of the last real assembly where SillyTavern knows ' +
                        'them, else counted by Maestro; the card, lore and history are shown by size only.',
                }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Dry run: ${view.messages.length} parts, ~${view.tokens.total} tokens`,
                    `Пробная сборка: частей ${view.messages.length}, ~${view.tokens.total} токенов`,
                ),
            };
        },
    });

/* ------------------------------------------------------------------ neighbour_prompts */

const neighbourList = (app: App): ToolSpec =>
    readTool({
        name: 'neighbour_prompts',
        description:
            'Instruction texts other extensions put into the prompt (DES tracker and its instructions, HTML, ' +
            'coloured dialogue, narrator, NAI Studio image rules, Qvink memory, the DES-RU language rule, ' +
            "CarrotKernel's insert, Maestro's own injections): who owns each, whether it can be changed everywhere " +
            'or copied for this character or chat, and whether a copy is on. `id` gives one entry with its texts: ' +
            'what goes to the model here, the extension’s own text, the built-in text and the copies.',
        parameters: objectSchema({ id: prop.string('Entry id (from the list) for its full texts.') }),
        available: needsApi('neighbourPrompts'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const api = neighbourPrompts(app);
            if (!api) return notice(ctx, 'The neighbour prompts module is off.', 'Модуль «Промпты соседей» выключен.');
            const report = safely(() => api.lastReport(), null);
            const id = strArg(args, 'id', 120);
            if (id) {
                const entry = safely(() => api.get(id), null);
                if (!entry) {
                    return notice(ctx, 'No such entry.', 'Такой записи нет.', {
                        ids: safely(() => api.list(), [] as NeighbourPrompt[]).map((item) => item.id),
                    });
                }
                const room = budget(ctx);
                const fitted = fitToSize((scale) => {
                    const max = Math.max(200, Math.floor((room / 4) * scale));
                    return compact({
                        id: entry.id,
                        owner: entry.owner,
                        name: entry.label,
                        description: entry.description,
                        present: entry.present,
                        editableEverywhere: entry.editable,
                        copyable: entry.scopable,
                        usedIn: entry.usedIn,
                        note: entry.note,
                        textHere: cut(entry.text, max),
                        extensionText: entry.globalText === entry.text ? undefined : cut(entry.globalText, max),
                        builtIn:
                            entry.defaultText !== undefined && entry.defaultText !== entry.globalText
                                ? cut(entry.defaultText, max)
                                : undefined,
                        copies: compact({
                            character:
                                entry.scoped.character === undefined ? undefined : cut(entry.scoped.character, max),
                            chat: entry.scoped.chat === undefined ? undefined : cut(entry.scoped.chat, max),
                        }),
                    });
                }, room);
                return {
                    data: fitted.data,
                    untrusted: true,
                    summary: say(ctx, `«${entry.label}»`, `«${entry.label}»`),
                };
            }
            const entries = safely(() => api.list(), [] as NeighbourPrompt[]);
            return {
                data: compact({
                    entries: entries.map((entry) =>
                        compact({
                            id: entry.id,
                            owner: entry.owner,
                            name: entry.label,
                            present: entry.present,
                            editableEverywhere: entry.editable,
                            copyable: entry.scopable,
                            usedIn: entry.usedIn,
                            copy: compact({
                                character: entry.scoped.character !== undefined || undefined,
                                chat: entry.scoped.chat !== undefined || undefined,
                            }),
                            chars: entry.text.length,
                            note: entry.note ? cut(entry.note, 160) : undefined,
                        }),
                    ),
                    lastGeneration: report
                        ? compact({
                              copiesUsed: report.replaced.length ? report.replaced : undefined,
                              copiesNotFound: report.notFound.length ? report.notFound : undefined,
                          })
                        : undefined,
                }),
                untrusted: true,
                summary: say(ctx, `Neighbour prompts: ${entries.length}`, `Промпты соседей: ${entries.length}`),
            };
        },
    });

export function presetReadTools(app: App): ToolSpec[] {
    return [
        presetList(app),
        presetBlockRead(app),
        presetParams(app),
        presetFindings(app),
        presetCompare(app),
        presetVersions(app),
        presetDryRun(app),
        neighbourList(app),
    ];
}
