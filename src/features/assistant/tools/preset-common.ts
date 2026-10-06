// Shared parts of the assistant's preset tools (M33 over M34/M36, plan-2 §1 and «Области действия»): the Preset
// Studio's APIs found at run time, the scopes the chat open now offers and their names on the card, blocks found by
// identifier or name, the base an edit of a scope is made on (the saved base with the lower scopes laid over it), the
// ops of higher scopes that win over an edit, and the quirks of the active model. Read and write tools use it.
import { stableHash } from '../../../domain/hash';
import { connectionFrom, modelQuirks } from '../../../domain/preset-analysis-hints';
import { effectiveOrder, promptsOf } from '../../../domain/preset-layer-apply';
import { promptName } from '../../../domain/preset-ui-blocks';
import type { App } from '../../../shared/contracts';
import type { NeighbourPromptsApi } from '../../neighbourPrompts/api';
import type { PresetAnalysisApi } from '../../presetStudio/analysis-api';
import type { LayerOp, LayerScope, LayerScopeInfo, PresetLayerApi, ScopedLayerOp } from '../../presetStudio/layer-api';
import type { PresetBody, PresetPrompt, PresetStore } from '../../presetStudio/store-api';
import type { ScopeOption } from '../api';

export const STORE_KEY = 'presetStore';
export const LAYER_KEY = 'presetLayer';
export const ANALYSIS_KEY = 'presetAnalysis';
export const NEIGHBOURS_KEY = 'neighbourPrompts';

/** The scopes in the order they are laid over the base. */
export const SCOPE_ORDER: readonly LayerScope[] = ['global', 'character', 'chat'];

export type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface PresetApis {
    store: PresetStore;
    layer: PresetLayerApi;
}

function api<T>(app: App, key: string): T | null {
    try {
        return app.modules.api<T>(key) ?? null;
    } catch {
        return null;
    }
}

export function presetStore(app: App): PresetStore | null {
    return api<PresetStore>(app, STORE_KEY);
}

export function presetLayer(app: App): PresetLayerApi | null {
    return api<PresetLayerApi>(app, LAYER_KEY);
}

export function presetAnalysis(app: App): PresetAnalysisApi | null {
    return api<PresetAnalysisApi>(app, ANALYSIS_KEY);
}

export function neighbourPrompts(app: App): NeighbourPromptsApi | null {
    return api<NeighbourPromptsApi>(app, NEIGHBOURS_KEY);
}

/** The store and the layer together (the write tools need both). */
export function presetApis(app: App): PresetApis | null {
    const store = presetStore(app);
    const layer = presetLayer(app);
    return store && layer ? { store, layer } : null;
}

function quietly<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

/* ------------------------------------------------------------------ scopes */

export function scopeContext(layer: PresetLayerApi | null): LayerScopeInfo | null {
    return layer ? quietly(() => layer.context?.() ?? null, null) : null;
}

/** Global always; the card's and the chat's when a character chat is open (and the layer knows scopes). */
export function availableScopes(layer: PresetLayerApi | null): LayerScope[] {
    const context = scopeContext(layer);
    const scopes: LayerScope[] = ['global'];
    if (context?.character) scopes.push('character');
    if (context?.chat) scopes.push('chat');
    return scopes;
}

/** «Везде» / «Этот персонаж (Алиса)» / «Этот чат». */
export function scopeLabel(say: Translate, scope: LayerScope, layer: PresetLayerApi | null): string {
    if (scope === 'character') {
        const name = scopeContext(layer)?.character?.name;
        return name ? say('m33w.scope.characterNamed', { name }) : say('m33w.scope.character');
    }
    return say(`m33w.scope.${scope}`);
}

/** The card's scope switch: every scope offered now, or only `fixed` (a block the layer added stays in its scope). */
export function scopeChoices(say: Translate, layer: PresetLayerApi | null, fixed?: LayerScope | null): ScopeOption[] {
    const scopes = fixed ? [fixed] : availableScopes(layer);
    return scopes.map((scope) => ({ value: scope, label: scopeLabel(say, scope, layer) }));
}

export function isScope(value: unknown): value is LayerScope {
    return value === 'global' || value === 'character' || value === 'chat';
}

/* ------------------------------------------------------------------ blocks */

/** A block of a preset with its place in the prompt order (index -1 and enabled null: not in the order). */
export interface BlockRow {
    identifier: string;
    prompt: PresetPrompt;
    enabled: boolean | null;
    index: number;
}

/** Blocks of the working copy: the active order first, then the blocks out of it. */
export function workingRows(store: PresetStore): BlockRow[] {
    const prompts = quietly(() => store.working().prompts ?? [], [] as PresetPrompt[]);
    const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
    const rows: BlockRow[] = [];
    const seen = new Set<string>();
    quietly(() => store.prompts(), []).forEach((row, index) => {
        const prompt = row.prompt ?? byId.get(row.item.identifier);
        if (!prompt || seen.has(row.item.identifier)) return;
        seen.add(row.item.identifier);
        rows.push({ identifier: row.item.identifier, prompt, enabled: row.item.enabled, index });
    });
    for (const prompt of prompts) {
        if (seen.has(prompt.identifier)) continue;
        seen.add(prompt.identifier);
        rows.push({ identifier: prompt.identifier, prompt, enabled: null, index: -1 });
    }
    return rows;
}

/** Blocks of a saved (or any) preset body in its order. */
export function bodyRows(body: PresetBody): BlockRow[] {
    const prompts = promptsOf(body) as PresetPrompt[];
    const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
    const rows: BlockRow[] = [];
    const seen = new Set<string>();
    effectiveOrder(body).forEach((item, index) => {
        const prompt = byId.get(item.identifier);
        if (!prompt || seen.has(item.identifier)) return;
        seen.add(item.identifier);
        rows.push({ identifier: item.identifier, prompt, enabled: item.enabled !== false, index });
    });
    for (const prompt of prompts) {
        if (seen.has(prompt.identifier)) continue;
        seen.add(prompt.identifier);
        rows.push({ identifier: prompt.identifier, prompt, enabled: null, index: -1 });
    }
    return rows;
}

export type BlockLookup = { row: BlockRow } | { problem: 'missing' | 'ambiguous' };

/** A block by identifier, else by its name (case-insensitive; several blocks of that name are a problem). */
export function lookupBlock(rows: readonly BlockRow[], wanted: string): BlockLookup {
    const exact = rows.find((row) => row.identifier === wanted);
    if (exact) return { row: exact };
    const lower = wanted.trim().toLowerCase();
    const named = rows.filter((row) => promptName(row.prompt).trim().toLowerCase() === lower);
    if (named.length > 1) return { problem: 'ambiguous' };
    return named[0] ? { row: named[0] } : { problem: 'missing' };
}

/* ------------------------------------------------------------------ the layer */

/** The layer's text fingerprint (the studio's baseHashOf: line ends normalised). */
export function baseHashOf(text: string): string {
    return stableHash(text.replace(/\r\n/g, '\n'));
}

/** The saved base body; without ST's cache, the working copy with the layer stripped (as the studio does). */
export function savedBase(apis: PresetApis, base: string): PresetBody {
    const saved = quietly(() => apis.store.saved(base), null);
    if (saved) return saved;
    return quietly(() => apis.layer.strip(base, apis.store.working()), {} as PresetBody);
}

/** What an edit of `scope` is made on: the saved base with the lower scopes laid over it. */
export function bodyBelow(apis: PresetApis, base: string, scope: LayerScope): PresetBody {
    if (scope !== 'global') {
        const below = quietly(() => apis.layer.below?.(base, scope) ?? null, null);
        if (below) return below;
    }
    return savedBase(apis, base);
}

/** The ops laid over a base now (every scope), or []. */
export function layerOps(layer: PresetLayerApi, base: string): ScopedLayerOp[] {
    return quietly(() => layer.get(base)?.ops ?? [], [] as ScopedLayerOp[]);
}

/** The block a layer op is about (null for body keys). */
export function opTarget(op: LayerOp): string | null {
    if (op.op === 'add') return op.prompt.identifier;
    if (op.op === 'key') return null;
    return op.identifier;
}

/** The scope whose layer added this block (null: a block of the base). */
export function ownScope(layer: PresetLayerApi, base: string, identifier: string): LayerScope | null {
    const own = layerOps(layer, base).find((op) => op.op === 'add' && op.prompt.identifier === identifier);
    return own ? (own.scope ?? 'global') : null;
}

function above(scope: LayerScope): LayerScope[] {
    return SCOPE_ORDER.slice(SCOPE_ORDER.indexOf(scope) + 1);
}

/**
 * Ops of the scopes above `scope` that change the same thing (a block's field, its state or place, a parameter): they
 * are laid over later, so an edit in `scope` does not show in the chat open now.
 */
export function shadowing(
    layer: PresetLayerApi,
    base: string,
    scope: LayerScope,
    what:
        | { kind: 'edit'; identifier: string; field: string }
        | { kind: 'toggle' | 'move'; identifier: string }
        | {
              kind: 'key';
              key: string;
          },
): ScopedLayerOp[] {
    const higher = new Set(above(scope));
    return layerOps(layer, base).filter((op) => {
        if (!higher.has(op.scope ?? 'global')) return false;
        if (what.kind === 'key') return op.op === 'key' && op.key === what.key;
        if (op.op === 'add') {
            if (op.prompt.identifier !== what.identifier) return false;
            return what.kind === 'edit' ? what.field in op.prompt : true;
        }
        if (op.op === 'key' || op.identifier !== what.identifier) return false;
        if (what.kind === 'edit') return op.op === 'edit' && what.field in op.patch;
        return op.op === what.kind;
    });
}

/** Quirks of the model of the active connection (DeepSeek V4 through OpenRouter…). */
export function activeQuirks(app: App): Set<string> {
    return quietly(() => modelQuirks(connectionFrom(app.host.ctx().chatCompletionSettings)) as Set<string>, new Set());
}
