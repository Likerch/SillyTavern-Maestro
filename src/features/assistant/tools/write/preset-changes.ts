// Changes of the chat preset the assistant proposes (M33 over M34, plan-2 §1 «Ассистент работает с пресетами»). One
// builder per kind of edit turns the model's arguments into a PresetChange: what the card shows (a summary, before /
// after in the user's words with the block texts whole, warnings), the scope it goes to now and whether the card may
// switch it, and apply(scope) — the op recorded in the layer of that scope first (it is what survives an update of the
// base preset and a chat switch), then the working copy through the store (Prompt Manager's own methods) brought to
// what the layer gives in the chat open now: an op of a higher scope wins for a field, a state, a place or a parameter;
// a text edit there was made on the old text and turns into a conflict (the new text works until the user resolves
// it). So the preset never looks unsaved after an edit. The preset file is never written (plan-2 В1, В2: «Применить»
// on the card is the save). Like the studio's edit router: a block the layer added is edited in its own scope; the
// layer cannot delete a block of the base, so «remove» switches it off there. Single tools wrap one change, packs
// several (preset.ts).
import {
    ArgError,
    clip,
    isDict,
    optEnum,
    optInt,
    optString,
    reqBool,
    reqEnum,
    reqObject,
    reqString,
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
import type { ConditionMode } from '../../../../domain/assistant-write-preset';
import {
    applyReplacements,
    ORDER_PLACES,
    paramValue,
    placeBlock,
    roleWarnings,
} from '../../../../domain/assistant-write-presets';
import type { TextReplacement } from '../../../../domain/assistant-write-presets';
import { conditionalInfo, readFlagEntries } from '../../../../domain/preset-conditional-check';
import { effectiveOrder, findPrompt } from '../../../../domain/preset-layer-apply';
import { isMaestroFlag } from '../../../../domain/preset-conditional-syntax';
import {
    blockFields,
    canEditBlock,
    canEditText,
    isInChat,
    isMarker,
    promptDepth,
    promptName,
    promptRole,
    promptText,
    PROMPT_ROLES,
} from '../../../../domain/preset-ui-blocks';
import type { BlockFields } from '../../../../domain/preset-ui-blocks';
import type { App } from '../../../../shared/contracts';
import type { DirectorApi } from '../../../director/api';
import type { LayerOp, LayerScope } from '../../../presetStudio/layer-api';
import type { PresetBody, PresetPrompt, PresetStore } from '../../../presetStudio/store-api';
import {
    baseHashOf,
    bodyBelow,
    bodyRows,
    isScope,
    layerOps,
    lookupBlock,
    opTarget,
    ownScope,
    presetApis,
    scopeLabel,
    shadowing,
    workingRows,
} from '../preset-common';
import type { BlockRow, PresetApis } from '../preset-common';
import { failure, newUuid } from './common';
import type { Say } from './strings';

/** Longest block text the assistant writes. */
export const MAX_BLOCK_TEXT = 60_000;
const DEFAULT_DEPTH = 4;
const DEFAULT_ORDER = 100;

/** One proposed change of the preset. */
export interface PresetChange {
    /** What it touches: a pack refuses two changes of the same thing (the second would be planned on stale data). */
    key: string;
    summary: string;
    target: string;
    before: unknown;
    after: unknown;
    /** The scope it goes to now; `fixed`: the card offers only this one (a block the layer added). */
    scope: LayerScope;
    fixed: boolean;
    /** Block texts on the card: kept whole. */
    full?: boolean;
    apply(scope: LayerScope): Promise<Dict>;
}

export interface ChangeContext {
    app: App;
    apis: PresetApis;
    say: Say;
    /** The preset the change is planned on (the current one). */
    base: string;
    quirks: ReadonlySet<string>;
}

/** Builds the changes of one tool call (several for a list of blocks or parameters). */
export type ChangeBuilder = (ctx: ChangeContext, args: Dict, scope: LayerScope) => PresetChange[];

/* ------------------------------------------------------------------ card values in words */

/** `{ «Текст»: …, «Роль»: … }`: card values keyed by the user's words (no JSON field names on the card). */
function fields(say: Say, entries: readonly (readonly [string, unknown])[]): Dict {
    const out: Dict = {};
    for (const [key, value] of entries) out[say(`m33w.field.${key}`)] = value;
    return out;
}

function withWarnings(say: Say, values: Dict, warnings: readonly string[]): Dict {
    if (warnings.length) values[say('m33w.field.warnings')] = [...warnings];
    return values;
}

function roleWord(say: Say, role: string): string {
    return say(`m33w.role.${role}`);
}

function stateWord(say: Say, on: boolean): string {
    return say(on ? 'm33w.state.on' : 'm33w.state.off');
}

function placeWord(say: Say, position: number, depth: number): string {
    return position === 1 ? say('m33w.preset.place.inChat', { depth }) : say('m33w.preset.place.inList');
}

/** «в начале» / «после «Main Prompt»» for a block in an order. */
function orderWord(say: Say, order: readonly string[], identifier: string, names: ReadonlyMap<string, string>): string {
    const index = order.indexOf(identifier);
    if (index <= 0) return say('m33w.preset.place.start');
    const previous = order[index - 1] ?? '';
    return say('m33w.preset.place.after', { block: names.get(previous) ?? previous });
}

/* ------------------------------------------------------------------ blocks and checks */

function target(ctx: ChangeContext, name?: string): string {
    return name
        ? ctx.say('m33w.target.presetBlock', { preset: ctx.base, name })
        : ctx.say('m33w.target.preset', { preset: ctx.base });
}

/** A block of the working copy by identifier or name. */
function findBlock(ctx: ChangeContext, wanted: string): BlockRow {
    const found = lookupBlock(workingRows(ctx.apis.store), wanted);
    if ('row' in found) return found.row;
    if (found.problem === 'ambiguous') throw failure(ctx.say, 'presetAmbiguous', { block: wanted });
    throw failure(ctx.say, 'presetNoBlock', { block: wanted, preset: ctx.base });
}

/** The scope a block's change goes to: a block the layer added stays in its own scope. */
function blockScope(ctx: ChangeContext, identifier: string, wanted: LayerScope): { scope: LayerScope; fixed: boolean } {
    const own = ownScope(ctx.apis.layer, ctx.base, identifier);
    return own ? { scope: own, fixed: true } : { scope: wanted, fixed: false };
}

/** A base block must be in the base below the scope (a block made outside the studio and not saved is not). */
function requireInBase(
    apis: PresetApis,
    say: Say,
    base: string,
    identifier: string,
    scope: LayerScope,
    name: string,
): PresetPrompt {
    const prompt = bodyRows(bodyBelow(apis, base, scope)).find((row) => row.identifier === identifier)?.prompt;
    if (!prompt) throw failure(say, 'presetOutside', { name });
    return prompt;
}

/** The APIs at apply time, the preset unchanged since the plan. */
function live(ctx: ChangeContext): PresetApis {
    const apis = presetApis(ctx.app);
    if (!apis) throw failure(ctx.say, 'presetUnavailable');
    const current = apis.store.current();
    if (current !== ctx.base) throw failure(ctx.say, 'presetChanged', { preset: ctx.base, current });
    return apis;
}

function liveRow(ctx: ChangeContext, apis: PresetApis, identifier: string, name: string): BlockRow {
    const row = workingRows(apis.store).find((item) => item.identifier === identifier);
    if (!row) throw failure(ctx.say, 'presetBlockChanged', { name });
    return row;
}

/** The scope an op goes to at apply time (the block may have become the layer's own meanwhile). */
function applyScope(apis: PresetApis, base: string, identifier: string | null, scope: LayerScope): LayerScope {
    return identifier ? (ownScope(apis.layer, base, identifier) ?? scope) : scope;
}

/**
 * A card warning when a higher scope already changes the same thing: a field, a state, a place or a parameter of that
 * scope wins in the chat open now; a text edit there was made on the old text, so it turns into a conflict the user
 * resolves in the Preset Studio (until then this text works).
 */
function shadowWarning(ctx: ChangeContext, scope: LayerScope, what: Parameters<typeof shadowing>[3]): string[] {
    const ops = shadowing(ctx.apis.layer, ctx.base, scope, what);
    const first = ops[0];
    if (!first) return [];
    const params = { scope: scopeLabel(ctx.say, first.scope, ctx.apis.layer) };
    const text = what.kind === 'edit' && what.field === 'content' && first.op === 'edit';
    return [ctx.say(text ? 'm33w.preset.warn.conflictAbove' : 'm33w.preset.warn.shadowed', params)];
}

/** What the layer gives now in the chat open now: the saved base with every scope laid over it (null: unknown). */
function expectedBody(apis: PresetApis, base: string): PresetBody | null {
    try {
        const saved = apis.store.saved(base);
        return saved ? apis.layer.apply(base, saved).body : null;
    } catch {
        return null;
    }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * After an op is recorded, the working copy takes the block's fields as the layer gives them now (a higher scope may
 * win, or turn into a conflict that keeps this text); without a known saved base, the patch as it is.
 */
async function syncFields(
    apis: PresetApis,
    base: string,
    identifier: string,
    patch: Partial<PresetPrompt>,
): Promise<void> {
    const expected = expectedBody(apis, base);
    const want = expected ? findPrompt(expected, identifier) : undefined;
    const now = workingRows(apis.store).find((row) => row.identifier === identifier)?.prompt;
    if (!now) return;
    const next: Partial<PresetPrompt> = {};
    for (const [field, value] of Object.entries(patch)) {
        const target = want ? want[field] : value;
        if (target !== undefined && !same(target, now[field])) next[field] = target;
    }
    if (Object.keys(next).length) await apis.store.updatePrompt(identifier, next);
}

/** The block's state as the layer gives it now (`fallback` without a known saved base). */
async function syncState(apis: PresetApis, base: string, identifier: string, fallback: boolean): Promise<void> {
    const expected = expectedBody(apis, base);
    const want = expected
        ? (effectiveOrder(expected).find((item) => item.identifier === identifier)?.enabled ?? fallback)
        : fallback;
    const now = apis.store.prompts().find((row) => row.item.identifier === identifier)?.item.enabled;
    if (now !== undefined && now !== want) await apis.store.setEnabled([identifier], want);
}

/**
 * The prompt order as the layer gives it now; `fallback` (the order the move planned) without a known saved base, or
 * when the working copy lists blocks the layer does not know (unsaved ones: they keep their places).
 */
async function syncOrder(apis: PresetApis, base: string, fallback: readonly string[]): Promise<void> {
    const now = apis.store.prompts().map((row) => row.item.identifier);
    const expected = expectedBody(apis, base);
    const present = new Set(now);
    const layered = expected
        ? effectiveOrder(expected)
              .map((item) => item.identifier)
              .filter((identifier) => present.has(identifier))
        : [];
    const want = layered.length === now.length ? layered : [...fallback];
    if (want.join('\n') !== now.join('\n')) await apis.store.reorder(want);
}

/** A parameter as the layer gives it now (`fallback` without a known saved base). */
async function syncKey(apis: PresetApis, base: string, key: string, fallback: unknown): Promise<void> {
    const expected = expectedBody(apis, base);
    const want = expected && Object.hasOwn(expected, key) ? expected[key] : fallback;
    if (!same(want, apis.store.working()[key])) await apis.store.setKeys({ [key]: want });
}

function roleWarningTexts(
    ctx: ChangeContext,
    row: BlockRow | null,
    prompt: PresetPrompt,
    changedRole: boolean,
): string[] {
    const order = workingRows(ctx.apis.store)
        .filter((item) => item.index >= 0)
        .map((item) => item.identifier);
    const history = order.indexOf('chatHistory');
    const at = row ? order.indexOf(row.identifier) : -1;
    const codes = roleWarnings(
        {
            role: promptRole(prompt),
            inChat: isInChat(prompt),
            depth: promptDepth(prompt),
            afterHistory: history >= 0 && at > history,
            text: promptText(prompt),
        },
        ctx.quirks,
        changedRole,
    );
    return codes.map((code) => ctx.say(`m33w.preset.warn.${code}`));
}

/* ------------------------------------------------------------------ edit */

const FIELD_OF: Readonly<Record<string, keyof BlockFields>> = {
    content: 'content',
    name: 'name',
    role: 'role',
    injection_position: 'position',
    injection_depth: 'depth',
    injection_order: 'order',
};

function replacementsOf(args: Dict): TextReplacement[] | undefined {
    const raw = args.replace;
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw) || !raw.length) throw new ArgError('argType', { name: 'replace', expected: 'list' });
    if (raw.length > 50) throw new ArgError('argTooMany', { name: 'replace', max: 50 });
    return raw.map((item) => {
        if (!isDict(item)) throw new ArgError('argType', { name: 'replace', expected: 'object' });
        const find = optString(item, 'find', { raw: true, max: MAX_BLOCK_TEXT });
        if (find === undefined) throw new ArgError('argMissing', { name: 'find' });
        const replace = optString(item, 'with', { raw: true, max: MAX_BLOCK_TEXT, allowEmpty: true }) ?? '';
        return { find, replace };
    });
}

export const editChanges: ChangeBuilder = (ctx, args, wanted) => {
    const { say } = ctx;
    const row = findBlock(ctx, reqString(args, 'block', { max: 200 }));
    const prompt = row.prompt;
    const identifier = row.identifier;
    const name = promptName(prompt);
    const old = blockFields(prompt);
    const content = optString(args, 'content', { raw: true, max: MAX_BLOCK_TEXT, allowEmpty: true });
    const replace = replacementsOf(args);
    if (content !== undefined && replace) throw new ArgError('argOneOf', { a: 'content', b: 'replace' });
    const patch: Partial<PresetPrompt> = {};
    if (content !== undefined || replace) {
        if (!canEditText(prompt)) throw failure(say, 'presetMarkerText', { name });
        const next = replace ? applyReplacements(old.content, replace) : (content ?? '');
        if (next !== old.content) patch.content = next;
    }
    const newName = optString(args, 'name', { max: 100 });
    if (newName !== undefined && newName !== old.name) patch.name = newName;
    const role = optEnum(args, 'role', PROMPT_ROLES);
    if (role !== undefined && role !== old.role) patch.role = role;
    const depth = optInt(args, 'depth', 0, 9999);
    let placement = optEnum(args, 'placement', ['list', 'chat'] as const);
    if (placement === undefined && depth !== undefined) placement = 'chat';
    const position = placement === undefined ? undefined : placement === 'chat' ? 1 : 0;
    if (position !== undefined && position !== old.position) patch.injection_position = position;
    if (depth !== undefined && depth !== old.depth) patch.injection_depth = depth;
    const order = optInt(args, 'order', 0, 9999);
    if (order !== undefined && order !== old.order) patch.injection_order = order;
    const structural = Object.keys(patch).some((key) => key !== 'content' && key !== 'name');
    if (structural && !canEditBlock(prompt)) throw failure(say, 'presetMarkerPlace', { name });
    if (!Object.keys(patch).length) throw failure(say, 'presetNothing', { name });

    const { scope, fixed } = blockScope(ctx, identifier, wanted);
    if (!fixed) requireInBase(ctx.apis, say, ctx.base, identifier, scope, name);
    const next = { ...prompt, ...patch } as PresetPrompt;
    const before: [string, unknown][] = [];
    const after: [string, unknown][] = [];
    const words: string[] = [];
    if ('content' in patch) {
        before.push(['text', old.content]);
        after.push(['text', patch.content]);
        words.push(say('m33w.word.text'));
    }
    if ('name' in patch) {
        before.push(['name', old.name || name]);
        after.push(['name', patch.name]);
        words.push(say('m33w.word.name'));
    }
    if ('role' in patch) {
        before.push(['role', roleWord(say, old.role)]);
        after.push(['role', roleWord(say, patch.role ?? old.role)]);
        words.push(say('m33w.word.role'));
    }
    if ('injection_position' in patch || 'injection_depth' in patch) {
        before.push(['place', placeWord(say, old.position, old.depth)]);
        after.push(['place', placeWord(say, next.injection_position === 1 ? 1 : 0, promptDepth(next))]);
        words.push(say('m33w.word.place'));
    }
    if ('injection_order' in patch) {
        before.push(['order', old.order]);
        after.push(['order', patch.injection_order]);
        words.push(say('m33w.word.order'));
    }
    const warnings = [
        ...roleWarningTexts(ctx, row, next, 'role' in patch || 'injection_position' in patch),
        ...Object.keys(patch).flatMap((field) => shadowWarning(ctx, scope, { kind: 'edit', identifier, field })),
    ];
    return [
        {
            key: `block:${identifier}:edit:${Object.keys(patch).sort().join(',')}`,
            summary: say('m33w.preset.summary.edit', { name, fields: words.join(', ') }),
            target: target(ctx, name),
            before: fields(say, before),
            after: withWarnings(say, fields(say, after), [...new Set(warnings)]),
            scope,
            fixed,
            full: true,
            async apply(chosen) {
                const apis = live(ctx);
                const now = liveRow(ctx, apis, identifier, name);
                const nowFields = blockFields(now.prompt);
                for (const field of Object.keys(patch)) {
                    const key = FIELD_OF[field];
                    if (key && JSON.stringify(nowFields[key]) !== JSON.stringify(old[key])) {
                        throw failure(say, 'presetBlockChanged', { name });
                    }
                }
                const at = applyScope(apis, ctx.base, identifier, chosen);
                const own = ownScope(apis.layer, ctx.base, identifier) !== null;
                let op: LayerOp;
                if (own) op = { op: 'edit', identifier, patch, baseHash: baseHashOf('') };
                else {
                    const baseText = promptText(requireInBase(apis, say, ctx.base, identifier, at, name));
                    op = { op: 'edit', identifier, patch, baseHash: baseHashOf(baseText), baseText };
                }
                await apis.layer.record(ctx.base, op, at);
                await syncFields(apis, ctx.base, identifier, patch);
                return { identifier, preset: ctx.base, scope: at };
            },
        },
    ];
};

/* ------------------------------------------------------------------ toggle */

function toggleChange(ctx: ChangeContext, wantedBlock: string, enabled: boolean, wanted: LayerScope): PresetChange {
    const { say } = ctx;
    const row = findBlock(ctx, wantedBlock);
    const identifier = row.identifier;
    const name = promptName(row.prompt);
    if (row.enabled === null) throw failure(say, 'presetDetached', { name });
    if (identifier === 'chatHistory' && !enabled) throw failure(say, 'presetHistoryOff');
    if (row.enabled === enabled) throw failure(say, 'presetAlreadyState', { name, state: stateWord(say, enabled) });
    const { scope, fixed } = blockScope(ctx, identifier, wanted);
    if (!fixed) requireInBase(ctx.apis, say, ctx.base, identifier, scope, name);
    return {
        key: `block:${identifier}:toggle`,
        summary: say(enabled ? 'm33w.preset.summary.on' : 'm33w.preset.summary.off', { name }),
        target: target(ctx, name),
        before: fields(say, [['state', stateWord(say, !enabled)]]),
        after: withWarnings(
            say,
            fields(say, [['state', stateWord(say, enabled)]]),
            shadowWarning(ctx, scope, { kind: 'toggle', identifier }),
        ),
        scope,
        fixed,
        async apply(chosen) {
            const apis = live(ctx);
            const now = liveRow(ctx, apis, identifier, name);
            if (now.enabled !== row.enabled) throw failure(say, 'presetBlockChanged', { name });
            const at = applyScope(apis, ctx.base, identifier, chosen);
            if (!ownScope(apis.layer, ctx.base, identifier)) requireInBase(apis, say, ctx.base, identifier, at, name);
            await apis.layer.record(ctx.base, { op: 'toggle', identifier, enabled }, at);
            await syncState(apis, ctx.base, identifier, enabled);
            return { identifier, preset: ctx.base, enabled, scope: at };
        },
    };
}

export const toggleChanges: ChangeBuilder = (ctx, args, scope) => {
    const enabled = reqBool(args, 'enabled');
    const list = Array.isArray(args.blocks) ? args.blocks : undefined;
    if (list) {
        if (!list.length) throw new ArgError('argMissing', { name: 'blocks' });
        if (list.length > 20) throw new ArgError('argTooMany', { name: 'blocks', max: 20 });
        return list.map((item) => {
            if (typeof item !== 'string' || !item.trim())
                throw new ArgError('argType', { name: 'blocks', expected: 'list' });
            return toggleChange(ctx, item.trim(), enabled, scope);
        });
    }
    return [toggleChange(ctx, reqString(args, 'block', { max: 200 }), enabled, scope)];
};

/* ------------------------------------------------------------------ move */

function orderOf(store: PresetStore): string[] {
    return workingRows(store)
        .filter((row) => row.index >= 0)
        .map((row) => row.identifier);
}

function namesOf(store: PresetStore): Map<string, string> {
    return new Map(workingRows(store).map((row) => [row.identifier, promptName(row.prompt)]));
}

export const moveChanges: ChangeBuilder = (ctx, args, wanted) => {
    const { say } = ctx;
    const row = findBlock(ctx, reqString(args, 'block', { max: 200 }));
    const identifier = row.identifier;
    const name = promptName(row.prompt);
    if (row.index < 0) throw failure(say, 'presetDetached', { name });
    const place = reqEnum(args, 'place', ORDER_PLACES);
    const anchorName = optString(args, 'anchor', { max: 200 });
    const anchorId = anchorName ? findBlock(ctx, anchorName).identifier : undefined;
    const order = orderOf(ctx.apis.store);
    const moved = placeBlock(order, identifier, place, anchorId);
    const { scope, fixed } = blockScope(ctx, identifier, wanted);
    if (!fixed) requireInBase(ctx.apis, say, ctx.base, identifier, scope, name);
    const names = namesOf(ctx.apis.store);
    const where = orderWord(say, moved.order, identifier, names);
    return [
        {
            key: `block:${identifier}:move`,
            summary: say('m33w.preset.summary.move', { name, place: where }),
            target: target(ctx, name),
            before: fields(say, [['position', orderWord(say, order, identifier, names)]]),
            after: withWarnings(
                say,
                fields(say, [['position', where]]),
                shadowWarning(ctx, scope, { kind: 'move', identifier }),
            ),
            scope,
            fixed,
            async apply(chosen) {
                const apis = live(ctx);
                const now = orderOf(apis.store);
                if (now.join('\n') !== order.join('\n')) throw failure(say, 'presetOrderChanged');
                const at = applyScope(apis, ctx.base, identifier, chosen);
                if (!ownScope(apis.layer, ctx.base, identifier))
                    requireInBase(apis, say, ctx.base, identifier, at, name);
                await apis.layer.record(ctx.base, { op: 'move', identifier, anchor: moved.anchor }, at);
                await syncOrder(apis, ctx.base, moved.order);
                return { identifier, preset: ctx.base, scope: at };
            },
        },
    ];
};

/* ------------------------------------------------------------------ remove */

export const removeChanges: ChangeBuilder = (ctx, args, wanted) => {
    const { say } = ctx;
    const row = findBlock(ctx, reqString(args, 'block', { max: 200 }));
    const identifier = row.identifier;
    const name = promptName(row.prompt);
    const own = ownScope(ctx.apis.layer, ctx.base, identifier);
    if (own) {
        // A block the layer added: its ops go (in every scope), and the block leaves the working copy.
        return [
            {
                key: `block:${identifier}:remove`,
                summary: say('m33w.preset.summary.removeOwn', { name }),
                target: target(ctx, name),
                before: fields(say, [
                    ['name', name],
                    ['text', promptText(row.prompt)],
                ]),
                after: null,
                scope: own,
                fixed: true,
                full: true,
                async apply() {
                    const apis = live(ctx);
                    const indices = layerOps(apis.layer, ctx.base)
                        .map((op, index) => ({ op, index }))
                        .filter(({ op }) => opTarget(op) === identifier)
                        .map(({ index }) => index)
                        .sort((a, b) => b - a);
                    if (!indices.length) throw failure(say, 'presetBlockChanged', { name });
                    for (const index of indices) await apis.layer.remove(ctx.base, index);
                    if (workingRows(apis.store).some((item) => item.identifier === identifier)) {
                        await apis.store.removePrompt(identifier);
                    }
                    return { identifier, preset: ctx.base, removed: true };
                },
            },
        ];
    }
    if (identifier === 'chatHistory') throw failure(say, 'presetHistoryOff');
    if (row.enabled === null) throw failure(say, 'presetDetached', { name });
    if (row.enabled === false) throw failure(say, 'presetAlreadyState', { name, state: stateWord(say, false) });
    const change = toggleChange(ctx, identifier, false, wanted);
    return [
        {
            ...change,
            key: `block:${identifier}:toggle`,
            summary: say('m33w.preset.summary.removeBase', { name }),
            after: withWarnings(say, isDict(change.after) ? { ...change.after } : {}, [
                say('m33w.preset.warn.baseKept'),
            ]),
        },
    ];
};

/* ------------------------------------------------------------------ parameters */

/** A parameter's name in the studio's words («Температура»), else its key. */
export function paramName(app: App, key: string): string {
    const id = `m34.params.key.${key}`;
    const label = app.i18n.t(id);
    return label && label !== id ? label : key;
}

function paramChange(ctx: ChangeContext, key: string, raw: unknown, scope: LayerScope): PresetChange {
    const { say, app } = ctx;
    const value = paramValue(key, raw);
    const current = ctx.apis.store.working()[key];
    if (JSON.stringify(current ?? null) === JSON.stringify(value)) {
        throw failure(say, 'presetParamSame', { key: paramName(app, key) });
    }
    const label = paramName(app, key);
    const warnings = shadowWarning(ctx, scope, { kind: 'key', key });
    if (key === 'assistant_prefill' && typeof value === 'string' && value.trim() && ctx.quirks.has('prefillEos')) {
        warnings.push(say('m33w.preset.warn.prefillEos'));
    }
    const shown = (item: unknown) => (item === undefined || item === null || item === '' ? '—' : item);
    return {
        key: `key:${key}`,
        summary: say('m33w.preset.summary.param', {
            param: label,
            before: clip(String(shown(current)), 40),
            after: clip(String(shown(value)), 40),
        }),
        target: target(ctx),
        before: { [label]: shown(current) },
        after: withWarnings(say, { [label]: shown(value) }, warnings),
        scope,
        fixed: false,
        full: typeof value === 'string',
        async apply(chosen) {
            const apis = live(ctx);
            if (JSON.stringify(apis.store.working()[key] ?? null) !== JSON.stringify(current ?? null)) {
                throw failure(say, 'presetParamChanged', { key: label });
            }
            await apis.layer.record(ctx.base, { op: 'key', key, value }, chosen);
            await syncKey(apis, ctx.base, key, value);
            return { key, value, preset: ctx.base, scope: chosen };
        },
    };
}

export const paramChanges: ChangeBuilder = (ctx, args, scope) => {
    if (typeof args.key === 'string') return [paramChange(ctx, args.key.trim(), args.value, scope)];
    const params = reqObject(args, 'params');
    const entries = Object.entries(params);
    if (!entries.length) throw new ArgError('argMissing', { name: 'params' });
    if (entries.length > 20) throw new ArgError('argTooMany', { name: 'params', max: 20 });
    return entries.map(([key, value]) => paramChange(ctx, key.trim(), value, scope));
};

/* ------------------------------------------------------------------ flags of conditions */

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
                if (isDict(item) && typeof item.flag === 'string') names.push(item.flag);
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
function flagWarnings(ctx: ChangeContext, flag: string): string[] {
    const setters = setterFlags(ctx.app);
    flagStanding(flag, [...setters, ...presetFlags(ctx.apis.store)]);
    const warnings: string[] = [];
    // A Maestro flag nobody announces now (the director off, a mechanic of another card…) is never set.
    if (!setters.includes(flag) && isMaestroFlag(flag)) {
        warnings.push(ctx.say('m33w.preset.warn.flagNotInCatalogue', { flag }));
    }
    // `{{if}}` exists only in the new macro engine (P-133); ST 1.19 has it on by default.
    if (ctx.app.host.ctx().powerUserSettings?.experimental_macro_engine === false) {
        warnings.push(ctx.say('m33w.preset.warn.macroEngine'));
    }
    return warnings;
}

/* ------------------------------------------------------------------ add */

export const addChanges: ChangeBuilder = (ctx, args, scope) => {
    const { say, app } = ctx;
    const name = reqString(args, 'name', { max: 100 });
    const role = optEnum(args, 'role', PROMPT_ROLES) ?? 'system';
    let content = reqString(args, 'content', { raw: true, max: MAX_BLOCK_TEXT }).trim();
    const position = reqObject(args, 'position');
    const place = reqEnum(position, 'place', BLOCK_PLACES);
    const depth = optInt(position, 'depth', 0, 9999);
    const enabled = args.enabled === undefined || args.enabled === null ? true : reqBool(args, 'enabled');
    const condition =
        args.condition === undefined || args.condition === null ? undefined : reqObject(args, 'condition');
    let anchorLabel = '';
    let anchorId: string | null = null;
    if (place === 'after' || place === 'before') {
        const wanted = optString(position, 'block', { max: 200 });
        if (!wanted) throw failure(say, 'presetNeedAnchor', { place });
        const row = findBlock(ctx, wanted);
        anchorId = row.identifier;
        anchorLabel = promptName(row.prompt);
    }
    const anchor = anchorOf(place, anchorId);
    const warnings: string[] = [];
    let conditionText = '';
    if (condition) {
        const flag = reqString(condition, 'flag', { max: 100 });
        const mode = reqEnum(condition, 'mode', ['only', 'except'] as const);
        warnings.push(...flagWarnings(ctx, flag));
        content = conditionedText(content, conditionChoice(mode, flag));
        conditionText = say(`m33w.preset.cond.${mode}`, { flag });
    }
    if (!enabled) warnings.push(say('m33w.preset.warn.disabled'));
    const identifier = newUuid(app);
    const prompt: PresetPrompt = {
        identifier,
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
    warnings.push(...roleWarningTexts(ctx, null, prompt, role !== 'system'));
    const listPlace = say(`m33w.preset.place.${anchor.kind}`, { block: anchorLabel });
    const where = depth === undefined ? listPlace : `${listPlace}, ${say('m33w.preset.place.depth', { depth })}`;
    return [
        {
            key: `add:${identifier}`,
            summary: say('m33w.preset.summary.add', {
                name,
                role: roleWord(say, role),
                place: where,
                condition: conditionText,
            }),
            target: target(ctx),
            before: null,
            after: withWarnings(
                say,
                fields(say, [
                    ['name', name],
                    ['role', roleWord(say, role)],
                    ['place', where],
                    ['state', stateWord(say, enabled)],
                    ['text', content],
                ]),
                warnings,
            ),
            scope,
            fixed: false,
            full: true,
            async apply(chosen) {
                const apis = live(ctx);
                // The layer first (it is what survives a new base), then the working copy for this session.
                await apis.layer.record(ctx.base, { op: 'add', prompt, anchor, enabled }, chosen);
                const order = apis.store.prompts().map((row) => row.item.identifier);
                const added = await apis.store.addPrompt({ ...prompt, enabled }, storeAfterOf(order, anchor));
                const row = apis.store.prompts().find((item) => item.item.identifier === added);
                if (row && row.item.enabled !== enabled) await apis.store.setEnabled([added], enabled);
                return { identifier: added, preset: ctx.base, scope: chosen };
            },
        },
    ];
};

/* ------------------------------------------------------------------ condition */

export const conditionChanges: ChangeBuilder = (ctx, args, wanted) => {
    const { say } = ctx;
    const mode: ConditionMode = reqEnum(args, 'mode', CONDITION_MODES);
    const flag = optString(args, 'flag', { max: 100 }) ?? null;
    const row = findBlock(ctx, reqString(args, 'block', { max: 200 }));
    const prompt = row.prompt;
    const identifier = row.identifier;
    const name = promptName(prompt);
    if (isMarker(prompt)) throw failure(say, 'presetMarker', { name });
    const { scope, fixed } = blockScope(ctx, identifier, wanted);
    if (!fixed) requireInBase(ctx.apis, say, ctx.base, identifier, scope, name);
    const choice = conditionChoice(mode, flag);
    const warnings = mode !== 'always' && flag ? flagWarnings(ctx, flag) : [];
    const content = promptText(prompt);
    const next = conditionedText(content, choice);
    if (next === content) throw failure(say, 'presetAlready', { name });
    warnings.push(...shadowWarning(ctx, scope, { kind: 'edit', identifier, field: 'content' }));
    return [
        {
            key: `block:${identifier}:edit:content`,
            summary: say(`m33w.preset.summary.${mode}`, { name, flag: flag ?? '' }),
            target: target(ctx, name),
            before: fields(say, [['text', content]]),
            after: withWarnings(say, fields(say, [['text', next]]), warnings),
            scope,
            fixed,
            full: true,
            async apply(chosen) {
                const apis = live(ctx);
                const now = liveRow(ctx, apis, identifier, name);
                if (promptText(now.prompt) !== content) throw failure(say, 'presetBlockChanged', { name });
                const at = applyScope(apis, ctx.base, identifier, chosen);
                const own = ownScope(apis.layer, ctx.base, identifier) !== null;
                const baseText = own ? '' : promptText(requireInBase(apis, say, ctx.base, identifier, at, name));
                await apis.layer.record(
                    ctx.base,
                    {
                        op: 'edit',
                        identifier,
                        patch: { content: next },
                        baseHash: baseHashOf(baseText),
                        baseText,
                    },
                    at,
                );
                await syncFields(apis, ctx.base, identifier, { content: next });
                return { identifier, preset: ctx.base, scope: at };
            },
        },
    ];
};

/* ------------------------------------------------------------------ scope argument */

/** The `scope` argument: one the chat open now offers (global by default). */
export function scopeArg(
    ctx: { apis: PresetApis; say: Say },
    args: Dict,
    available: readonly LayerScope[],
): LayerScope {
    const raw = args.scope;
    if (raw === undefined || raw === null) return 'global';
    const scope = optEnum(args, 'scope', ['global', 'character', 'chat'] as const);
    if (!isScope(scope)) return 'global';
    if (!available.includes(scope))
        throw failure(ctx.say, 'presetScopeOff', { scope: scopeLabel(ctx.say, scope, null) });
    return scope;
}
