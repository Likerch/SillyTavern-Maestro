// «Твой слой» of the Preset Studio (M34 п.5–6, stage 5): PresetLayerApi over the layer files, laid over the base
// preset by ST itself. Host facts (research/parity-preset.md §10.2 п.3, §10.4 б, P-062, P-067, P-181):
// - the only moment to change what a preset loads is OAI_PRESET_CHANGED_BEFORE: `event.preset` is a clone of ST's
//   cached body and the keys it holds are then put into oai_settings (by reference) — so the layer is applied to
//   `event.preset` in place, with fresh arrays/objects for what changes;
// - BEFORE handler, in order: (1) skip while a rename runs (flag from PRESET_RENAMED_BEFORE to PRESET_RENAMED: ST
//   applies an empty `{}` preset in between), skip an empty or missing `preset`, skip a name without a layer (and a
//   name «Подготовить к отключению» asked to load once without it); (2) apply the ops by identifier — own blocks
//   with strict types, the order in list 100001 (created from 100000 or ST's default order when missing, since
//   Prompt Manager creates it only after AFTER), keys by preset key names; (3) a text edit whose base fingerprint no
//   longer matches keeps the base text and becomes a conflict (lastReport()); (4) copy the changed keys onto
//   `event.preset`. Everything is in memory: the handler is synchronous (ST holds /preset and connection profiles
//   on this promise, P-178); only if the layers are still loading does it wait, at most LOAD_WAIT_MS;
// - OAI_PRESET_CHANGED_AFTER: the fingerprint of base + layer in the working copy is remembered in the layer file,
//   and M4's baseline acknowledges the preset parts (an intentional change, not drift);
// - page load has no BEFORE: on APP_READY (or the first SETTINGS_LOADED) the working copy is compared with
//   apply(saved base); if the layer is missing or the base changed on the server, «Перевыбрать пресет со слоем» is
//   offered (a notice with an action that reselects the preset through ST, which fires BEFORE);
// - P11: a disabled module cannot take the layer out of the working copy without a preset change; it stays there
//   until the next change. «Подготовить к отключению» (prepareDisable) reselects the base once without the layer, or
//   saves base + layer as a normal preset.
// The layer never writes a preset file (P2): «Сохранить базу» is the store's job, with strip().
//
// Scopes (plan-2 «Области действия», layer-api.ts): the character and chat parts live in ScopedDocs (core/scoped-docs)
// — a Maestro file per card avatar and a per-chat document — and are laid over the global part in this order. What is
// laid over the working copy now is `applied` (the card and the chat whose parts it holds), kept in the module's
// settings next to ST's own copy of the working copy (settings.json), because page load has no BEFORE. On a chat
// switch (bus 'chat:changed') the parts of the chat left are stripped from the working copy and those of the chat
// opened are laid on through the store (PresetStore.syncWorking: no journal, no version, the preset stays saved).
// ST's own saves of the file («Обновить пресет», «Сохранить как», PresetManager.savePreset of other extensions) are
// built from the working copy: a fetch-gate hook on /api/presets/save writes them without the character and chat
// parts, and the cached body ST keeps of that save is cleaned the same way (and stripped again in the BEFORE of a
// «Сохранить как» that selects it).
import { tPlural } from '../../core/labels';
import {
    EMPTY_SCOPE_CONTEXT,
    ScopedDocs,
    currentScopeContext,
    sameScopeContext,
    scopeOwner,
} from '../../core/scoped-docs';
import type { ScopeContext, ScopeKind } from '../../core/scoped-docs';
import {
    applyLayer,
    contentOf,
    effectiveOrder,
    emptyReport,
    findPrompt,
    isDict,
} from '../../domain/preset-layer-apply';
import type {
    AddOp,
    LayerApplyReport as DomainReport,
    LayerBody,
    LayerOp as DomainOp,
} from '../../domain/preset-layer-apply';
import { planMigration, splitForeign, transferOps } from '../../domain/preset-layer-migrate';
import {
    baseFingerprint,
    baseMatches,
    layerFingerprint,
    mergeOp,
    opKey,
    resolveOp,
    setOpAt,
    validateOp,
    withOrigins,
} from '../../domain/preset-layer-ops';
import {
    CHAT_SCOPES,
    SCOPES,
    applyScoped,
    emptyScopeDoc,
    flatOps,
    holdsParts,
    plainOp,
    rebaseOp,
    sanitizeScopeDoc,
    stripScoped,
} from '../../domain/preset-layer-scopes';
import type { ScopeLayerDoc, ScopeOps } from '../../domain/preset-layer-scopes';
import { jsonCopy, valuesEqual } from '../../domain/settings-diff';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { GuardianApi } from '../guardian/api';
import type {
    Layer,
    LayerApplyReport,
    LayerChange,
    LayerOp,
    LayerScope,
    LayerScopeInfo,
    PresetBindings,
    PresetLayerApi,
    ScopedLayerOp,
} from './layer-api';
import { LayerFiles } from './layer-files';
import { LAYER_STRINGS } from './layer-strings';
import { paramLabel } from './param-labels';
import type { PresetBody, PresetPrompt, PresetStore } from './store-api';

export const PRESET_LAYER_KEY = 'presetLayer';
/** Journal target of layer changes (undo puts the op back). */
export const LAYER_TARGET = 'preset-layer';
export const LAYER_JOURNAL_KIND = 'preset.layer';
/** Journal target and kind of a preset bound to a card or a chat (undo puts the old binding back). */
export const BINDING_TARGET = 'preset-binding';
export const BINDING_JOURNAL_KIND = 'preset.binding';
/** Document kind of the character and chat parts (core/scoped-docs). */
export const PRESET_SCOPE_KIND = 'preset-scope';
/** The studio module's settings slice (what is laid over the working copy is kept there). */
export const STUDIO_SETTINGS_KEY = 'presetStudio';
const MODULE_ID = 'M34';
/** Longest wait of the BEFORE handler for layers still loading at start. */
const LOAD_WAIT_MS = 2000;
/** A rename that never reports PRESET_RENAMED (an error in between) must not block the layer for good. */
const RENAME_TIMEOUT_MS = 30_000;
/** M4 baseline paths a layer application changes on purpose. */
const PRESET_PATHS = ['preset.order', 'preset.toggles', 'preset.roles', 'preset.contents', 'preset.body'];
/** ST's preset save endpoint (src/endpoints/presets.js). */
const SAVE_URL_RE = /\/api\/presets\/save(?:[?#]|$)/;
/** How long a save ST made without the chat parts keeps its cached body (and the BEFORE that selects it) cleaned. */
const STRIP_WINDOW_MS = 5000;
/** ST updates its cache after the server answered: cleaned again a little later. */
const CACHE_FIX_DELAYS_MS = [0, 200, 1000];

type Dict = Record<string, unknown>;
type OfferReason = 'layerMissing' | 'baseChanged';

interface OpChange {
    key: string;
    index: number;
    before: DomainOp | null;
    after: DomainOp | null;
    scope: LayerScope;
    owner: string | null;
}

/** What the working copy holds, kept in the studio's settings (page load has no BEFORE). */
interface AppliedScope {
    base: string;
    avatar: string | null;
    chatId: string | null;
}

/**
 * What createPresetLayer returns: the API object itself (so it can be exposed as 'presetLayer' directly) plus the
 * lifecycle. Owners either own every disposer install() returns, or call dispose() — both are safe together.
 */
export interface PresetLayerHandle extends PresetLayerApi {
    api: PresetLayerApi;
    /** Subscribes to ST's preset events, registers the journal undo and starts loading the layers. */
    install(): Unsubscribe[];
    /** Runs the disposers of install() (module.ts adopt() calls it when the module is disabled). */
    dispose(): void;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Replaces the contents of a live object (ST's cache keeps references to it). */
function replaceContents(target: Dict, source: Dict): void {
    for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
    Object.assign(target, source);
}

export function createPresetLayer(app: App, log: Logger, store?: PresetStore): PresetLayerHandle {
    app.i18n.register(LAYER_STRINGS);
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const listeners = new Set<(change?: LayerChange) => void>();
    let saveErrorShown = false;
    const saveFailed = (base: string) => {
        if (saveErrorShown) return;
        saveErrorShown = true;
        app.ui.notice(t('m34.layerSvc.saveFailed', { name: base }), { level: 'error' });
    };
    const files = new LayerFiles(app.files, log, { onError: saveFailed });
    const scoped = new ScopedDocs<ScopeLayerDoc>(
        { files: app.files, chat: app.chat, log },
        {
            kind: PRESET_SCOPE_KIND,
            defaults: emptyScopeDoc,
            sanitize: sanitizeScopeDoc,
            onError: () => saveFailed(currentName()),
        },
    );

    let loading: Promise<void> | null = null;
    let loaded = false;
    let installed = false;
    let openai: Dict | null = null;
    let renaming: { oldName: string; newName: string } | null = null;
    let renameTimer: ReturnType<typeof setTimeout> | null = null;
    /** What BEFORE applied, for AFTER. */
    let pending: { name: string; base: LayerBody; body: LayerBody; ops: DomainOp[] } | null = null;
    /** BEFORE changed the report: AFTER tells the listeners (the working copy is final by then). */
    let reportDirty = false;
    let last: { name: string; report: DomainReport } | null = null;
    /** «Подготовить к отключению»: the next BEFORE of this name loads the base without the layer. */
    let suppressOnce: string | null = null;
    let checked = false;
    /** The card and the chat whose parts the working copy holds now. */
    let applied: ScopeContext = { ...EMPTY_SCOPE_CONTEXT };
    /** Loading the parts of the persisted `applied` (page load), awaited by the page-load check and the first sync. */
    let startup: Promise<void> = Promise.resolve();
    let contextChain: Promise<unknown> = Promise.resolve();
    /** Saves ST made without the chat parts, by preset name: their cached body and selection are cleaned too. */
    const pendingStrip = new Map<string, { parts: ScopeOps[]; until: number }>();
    const timers = new Set<ReturnType<typeof setTimeout>>();

    /* ------------------------------------------------------------ plumbing */

    const emit = (change: LayerChange = 'ops'): void => {
        for (const listener of [...listeners]) {
            try {
                listener(change);
            } catch (error) {
                log.error('preset layer listener failed', error);
            }
        }
    };

    /** Global ops of a base (the layer files). */
    const opsOf = (base: string): DomainOp[] => files.get(base)?.ops ?? [];

    /** Ops of one scope of a base for an owner (avatar or chat id; ignored for global). */
    const opsIn = (base: string, scope: LayerScope, owner: string | null): DomainOp[] => {
        if (scope === 'global') return opsOf(base);
        if (!owner) return [];
        return scoped.get(scope, owner)?.layers[base]?.ops ?? [];
    };

    /** The parts laid over a base in a context, in order (`scopes` picks some of them). */
    const partsFor = (base: string, context: ScopeContext, scopes: readonly LayerScope[] = SCOPES): ScopeOps[] =>
        scopes.map((scope) => ({
            scope,
            ops: opsIn(base, scope, scope === 'global' ? null : scopeOwner(context, scope)),
        }));

    /** Every op laid over a base now (global, the card's, the chat's). */
    const allOps = (base: string): DomainOp[] => flatOps(partsFor(base, applied));

    const below = (scope: LayerScope): LayerScope[] => SCOPES.slice(0, SCOPES.indexOf(scope));

    const currentName = (): string => {
        try {
            const name = store?.current();
            if (typeof name === 'string' && name) return name;
        } catch (error) {
            log.debug('store.current failed', error);
        }
        const name = app.host.ctx().chatCompletionSettings?.preset_settings_openai;
        return typeof name === 'string' ? name : '';
    };

    const loadOpenai = async (): Promise<Dict | null> => {
        if (openai || !app.host.caps.has('st.oai.promptManager')) return openai;
        try {
            openai = await app.host.modules.openai();
        } catch (error) {
            log.debug('openai module unavailable', error);
        }
        return openai;
    };

    /** ST's cached body of a preset (openai.js openai_settings / openai_setting_names, P-075). */
    const cachedBody = (name: string): LayerBody | null => {
        if (!openai) return null;
        const names = openai.openai_setting_names;
        const list = openai.openai_settings;
        const slot = isDict(names) ? names[name] : undefined;
        const body = Array.isArray(list) && typeof slot === 'number' ? list[slot] : undefined;
        return isDict(body) ? (body as LayerBody) : null;
    };

    const savedSync = (name: string): LayerBody | null => {
        if (store) {
            try {
                const body = store.saved(name);
                if (body) return body as LayerBody;
            } catch (error) {
                log.debug('store.saved failed', error);
            }
        }
        return cachedBody(name);
    };

    const savedBody = async (name: string): Promise<LayerBody | null> => {
        await loadOpenai();
        return savedSync(name);
    };

    /** The saved base with the scopes below `scope` laid over it (what an op of `scope` is made on). */
    const bodyBelow = (base: string, scope: LayerScope): LayerBody | null => {
        const saved = savedSync(base);
        if (!saved) return null;
        return scope === 'global' ? saved : applyScoped(saved, partsFor(base, applied, below(scope))).body;
    };

    const workingSync = (): LayerBody | null => {
        try {
            if (store) return store.working() as LayerBody;
            const get = openai?.getChatCompletionPreset;
            const body = typeof get === 'function' ? (get as () => unknown)() : null;
            return isDict(body) ? (body as LayerBody) : null;
        } catch (error) {
            log.debug('working copy unavailable', error);
            return null;
        }
    };

    const workingBody = async (): Promise<LayerBody | null> => {
        await loadOpenai();
        return workingSync();
    };

    const load = (): Promise<void> => {
        if (!loading) {
            loading = (async () => {
                await loadOpenai();
                const current = currentName();
                await files.load(current ? [current] : []);
            })()
                .catch((error: unknown) => log.warn('preset layers could not be loaded', error))
                .finally(() => {
                    loaded = true;
                });
        }
        return loading;
    };

    const setLast = (name: string, report: DomainReport | null): void => {
        last = report ? { name, report } : null;
    };

    /** Recomputes the report of the current preset against its saved base after a layer change. */
    const refreshReport = (base: string): void => {
        if (base !== currentName()) return;
        const parts = partsFor(base, applied);
        const saved = savedSync(base);
        if (!flatOps(parts).length) setLast(base, null);
        else if (saved) setLast(base, applyScoped(saved, parts).report);
    };

    const newIdentifier = (): string => {
        try {
            const id = app.host.ctx().uuidv4();
            if (typeof id === 'string' && id) return id;
        } catch {
            // fall through
        }
        return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `maestro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    };

    /* ------------------------------------------------------------ scopes */

    const info = (context: ScopeContext = applied): LayerScopeInfo => ({
        character: context.avatar ? { avatar: context.avatar, name: context.characterName ?? context.avatar } : null,
        chat: context.chatId ? { id: context.chatId } : null,
    });

    const settingsSlice = (): Dict => app.settings.module<Dict>(STUDIO_SETTINGS_KEY);

    /** Remembers what the working copy of `base` holds (settings, saved with ST's copy of the working copy). */
    const setApplied = (context: ScopeContext, base: string): void => {
        applied = { ...context };
        try {
            const slice = settingsSlice();
            const next: AppliedScope = { base, avatar: context.avatar, chatId: context.chatId };
            if (valuesEqual(slice.scopeApplied ?? null, next)) return;
            slice.scopeApplied = next;
            app.settings.save();
        } catch (error) {
            log.debug('applied scope not remembered', error);
        }
    };

    const persistedApplied = (): ScopeContext => {
        try {
            const value = settingsSlice().scopeApplied;
            if (!isDict(value) || value.base !== currentName()) return { ...EMPTY_SCOPE_CONTEXT };
            return {
                avatar: typeof value.avatar === 'string' && value.avatar ? value.avatar : null,
                characterName: null,
                chatId: typeof value.chatId === 'string' && value.chatId ? value.chatId : null,
            };
        } catch {
            return { ...EMPTY_SCOPE_CONTEXT };
        }
    };

    /** The part of a context whose documents are in memory (BEFORE never waits for the network). */
    const loadedPart = (context: ScopeContext): ScopeContext => {
        const avatar = context.avatar && scoped.has('character', context.avatar) ? context.avatar : null;
        const chatId = context.chatId && scoped.has('chat', context.chatId) ? context.chatId : null;
        return { avatar, characterName: avatar ? context.characterName : null, chatId };
    };

    /** The owner of a scope in the context laid over the working copy; throws when that scope is not available. */
    const ownerOf = (scope: LayerScope): string | null => {
        if (scope === 'global') return null;
        const owner = scopeOwner(applied, scope);
        if (!owner) throw new Error(`preset layer: no ${scope} is open`);
        return owner;
    };

    /** Changes the ops of one scope of a base: global ones through the layer files, the others through ScopedDocs. */
    const mutateOps = async (
        base: string,
        scope: LayerScope,
        owner: string | null,
        change: (ops: DomainOp[]) => DomainOp[],
    ): Promise<void> => {
        if (scope === 'global') {
            files.mutate(base, (file) => {
                file.ops = change(file.ops);
            });
            return;
        }
        if (!owner) throw new Error(`preset layer: no owner for the ${scope} scope`);
        await scoped.mutate(scope as ScopeKind, owner, (doc) => {
            const next = change(doc.layers[base]?.ops ?? []);
            if (next.length) doc.layers[base] = { ops: next, updatedAt: Date.now() };
            else delete doc.layers[base];
        });
    };

    /**
     * Brings the working copy to the scopes of the chat open now: the parts of the context it holds are stripped and
     * those of the new one laid on, through the store (no journal, no version: the preset does not become unsaved).
     */
    const runSync = async (): Promise<LayerScopeInfo> => {
        await load();
        await startup;
        const target = currentScopeContext(app.host);
        await scoped.load(target);
        if (!installed) return info();
        const base = currentName();
        const from = applied;
        if (sameScopeContext(from, target)) {
            applied = { ...target };
            return info();
        }
        const fromParts = partsFor(base, from, CHAT_SCOPES);
        const toParts = partsFor(base, target, CHAT_SCOPES);
        if (!base || valuesEqual(flatOps(fromParts), flatOps(toParts)) || !app.host.isChatCompletion()) {
            setApplied(target, base);
            emit('context');
            return info();
        }
        const working = await workingBody();
        if (!working || typeof store?.syncWorking !== 'function') {
            // Without the store the working copy cannot be rewritten: the next preset change lays the scopes on.
            log.warn('the scopes of this chat wait for the next preset change (no preset store)');
            setApplied(target, base);
            emit('context');
            return info();
        }
        const next = applyScoped(stripScoped(working, fromParts), toParts).body;
        setApplied(target, base);
        try {
            await store.syncWorking(next as PresetBody);
        } catch (error) {
            log.warn('the working copy did not take the scopes of this chat', error);
        }
        refreshReport(base);
        emit('context');
        return info();
    };

    const syncContext = (): Promise<LayerScopeInfo> => {
        const job = contextChain.then(runSync, runSync);
        contextChain = job.catch(() => undefined);
        return job;
    };

    /* ------------------------------------------------------------ journal */

    const journal = async (summary: string, base: string, changes: readonly OpChange[]): Promise<void> => {
        if (!changes.length) return;
        try {
            await app.journal.record({
                module: MODULE_ID,
                kind: LAYER_JOURNAL_KIND,
                summary,
                changes: changes.map((change) => ({
                    target: LAYER_TARGET,
                    ref:
                        change.scope === 'global'
                            ? { base, key: change.key, index: change.index }
                            : { base, key: change.key, index: change.index, scope: change.scope, owner: change.owner },
                    before: change.before,
                    after: change.after,
                })),
            });
        } catch (error) {
            log.warn('layer change was not journaled', error);
        }
    };

    /** Journal undo: the op under the key goes back to `before`, if nobody changed it since. */
    const undoChange = async (change: JournalChange): Promise<boolean> => {
        await load();
        const ref = change.ref;
        const base = typeof ref.base === 'string' ? ref.base : '';
        const key = typeof ref.key === 'string' ? ref.key : '';
        const scope: LayerScope = ref.scope === 'character' || ref.scope === 'chat' ? ref.scope : 'global';
        const owner = typeof ref.owner === 'string' && ref.owner ? ref.owner : null;
        if (!base || !key || (scope !== 'global' && !owner)) return false;
        if (scope !== 'global' && owner) await scoped.loadOne(scope, owner);
        const current = opsIn(base, scope, owner).find((op) => opKey(op) === key) ?? null;
        if (!valuesEqual(current, change.after ?? null)) {
            log.warn(`layer op ${key} of ${base} changed after this action; not undone`);
            return false;
        }
        const before =
            change.before !== null && validateOp(change.before) === null ? (change.before as DomainOp) : null;
        const index = typeof ref.index === 'number' ? ref.index : undefined;
        await mutateOps(base, scope, owner, (ops) => setOpAt(ops, key, before, index));
        refreshReport(base);
        emit();
        return true;
    };

    /** Journal undo of a binding: back to the preset bound before, if nobody changed it since. */
    const undoBinding = async (change: JournalChange): Promise<boolean> => {
        const scope = change.ref.scope === 'character' || change.ref.scope === 'chat' ? change.ref.scope : null;
        const owner = typeof change.ref.owner === 'string' ? change.ref.owner : '';
        if (!scope || !owner) return false;
        await scoped.loadOne(scope, owner);
        const current = scoped.get(scope, owner)?.binding?.preset ?? null;
        if (current !== (typeof change.after === 'string' ? change.after : null)) return false;
        const before = typeof change.before === 'string' && change.before ? change.before : null;
        await scoped.mutate(scope, owner, (doc) => {
            doc.binding = before ? { preset: before, at: Date.now() } : null;
        });
        emit('binding');
        return true;
    };

    /** An add op gets an identifier of its own: none given, or one the base already uses (a picked foreign block). */
    const ownIdentifier = (ops: readonly DomainOp[], op: AddOp, body: LayerBody | null): AddOp => {
        const id = op.prompt.identifier;
        if (id && ops.some((item) => item.op === 'add' && item.prompt.identifier === id)) return op;
        if (id && !(body && findPrompt(body, id))) return op;
        return { ...op, prompt: { ...op.prompt, identifier: newIdentifier() } };
    };

    /* ------------------------------------------------------------ journal summaries */

    /** A block's name for a journal summary: the user's own block, else the base's (its identifier at worst). */
    const blockName = (base: string, identifier: string): string => {
        const own = allOps(base).find((op): op is AddOp => op.op === 'add' && op.prompt.identifier === identifier);
        const prompt = own?.prompt ?? findPrompt(savedSync(base), identifier) ?? findPrompt(workingSync(), identifier);
        const name = typeof prompt?.name === 'string' ? prompt.name.trim() : '';
        return name || identifier;
    };

    const opBlock = (base: string, op: DomainOp): string =>
        op.op === 'add'
            ? (typeof op.prompt.name === 'string' && op.prompt.name.trim()) || blockName(base, op.prompt.identifier)
            : op.op === 'key'
              ? ''
              : blockName(base, op.identifier);

    const paramName = (key: string): string => paramLabel(key, app.i18n) ?? key;

    /** «(только в этом чате)»: where an edit lives, for journal summaries of the character and chat scopes. */
    const scopeSuffix = (scope: LayerScope): string => {
        if (scope === 'global') return '';
        if (scope === 'chat') return ` (${t('m34.layerSvc.scope.chat')})`;
        return ` (${t('m34.layerSvc.scope.character', { name: applied.characterName ?? applied.avatar ?? '' })})`;
    };

    /** «В слое «Marinara» выключен блок «Main»»: what one recorded operation does, in words. */
    const recordSummary = (base: string, op: DomainOp, scope: LayerScope): string => {
        if (op.op === 'key') {
            return t('m34.layerSvc.journal.key', { name: base, param: paramName(op.key) }) + scopeSuffix(scope);
        }
        const what = op.op === 'toggle' ? (op.enabled ? 'on' : 'off') : op.op;
        return t(`m34.layerSvc.journal.${what}`, { name: base, block: opBlock(base, op) }) + scopeSuffix(scope);
    };

    const removeSummary = (base: string, op: DomainOp, scope: LayerScope): string =>
        (op.op === 'key'
            ? t('m34.layerSvc.journal.removeKey', { name: base, param: paramName(op.key) })
            : t('m34.layerSvc.journal.remove', { name: base, block: opBlock(base, op) })) + scopeSuffix(scope);

    /* ------------------------------------------------------------ ST's preset manager */

    const presetManager = async (): Promise<Dict | null> => {
        if (!app.host.caps.has('st.presetManager')) return null;
        try {
            const module = await app.host.modules.presetManager();
            const get = module.getPresetManager;
            const manager = typeof get === 'function' ? (get as (apiId: string) => unknown)('openai') : null;
            return isDict(manager) ? manager : null;
        } catch (error) {
            log.debug('preset manager unavailable', error);
            return null;
        }
    };

    /** Selects a preset the way ST does (`change` of the list, then the application promise), so BEFORE runs. */
    const reselect = async (name?: string): Promise<string | null> => {
        const target = name ?? currentName();
        if (!target) return null;
        const manager = await presetManager();
        if (manager && typeof manager.findPreset === 'function' && typeof manager.selectPreset === 'function') {
            const value = (manager.findPreset as (preset: string) => unknown).call(manager, target);
            if (value !== undefined && value !== null) {
                await (manager.selectPreset as (preset: unknown) => Promise<void>).call(manager, value);
                return target;
            }
        }
        if (store) {
            await store.select(target);
            return target;
        }
        log.warn(`preset ${target} could not be reselected`);
        return null;
    };

    const prepareDisable = async (mode: 'reselectBase' | 'saveMerged', name?: string): Promise<string | null> => {
        await files.flush().catch((error: unknown) => log.warn('layer flush failed', error));
        const current = currentName();
        if (!current) return null;
        if (mode === 'reselectBase') {
            suppressOnce = current;
            try {
                return await reselect(current);
            } finally {
                suppressOnce = null;
            }
        }
        const target = name?.trim() || t('m34.layerSvc.mergedName', { name: current });
        if (store) {
            const saved = await store.saveAs(target);
            if (store.current() !== saved) await store.select(saved);
            return saved;
        }
        // No store: ST's own explicit-body save (writes the file, updates the cache and list, selects it, P-077).
        const manager = await presetManager();
        const working = await workingBody();
        if (!manager || typeof manager.savePreset !== 'function' || !working) {
            throw new Error('preset layer: base + layer cannot be saved without the preset store');
        }
        const body = { ...(cachedBody(current) ?? {}), ...jsonCopy(working) };
        await (manager.savePreset as (preset: string, data: unknown) => Promise<void>).call(manager, target, body);
        return target;
    };

    /* ------------------------------------------------------------ ST's own saves of the file */

    /** The character and chat parts of what a save of the current working copy would bake in (none: []). */
    const chatPartsNow = (): ScopeOps[] =>
        partsFor(currentName(), applied, CHAT_SCOPES).filter((part) => part.ops.length > 0);

    const later = (ms: number, run: () => void): void => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            run();
        }, ms);
        timers.add(timer);
    };

    /** ST put the body it sent into its cache: that copy loses the chat parts too. */
    const cleanCache = (name: string): void => {
        const entry = pendingStrip.get(name);
        if (!entry) return;
        if (entry.until < Date.now()) {
            pendingStrip.delete(name);
            return;
        }
        const cached = cachedBody(name);
        if (cached && holdsParts(cached, entry.parts)) {
            replaceContents(cached, jsonCopy(stripScoped(cached, entry.parts)) as Dict);
            log.debug(`cached body of ${name}: the character and chat edits taken out`);
        }
    };

    /**
     * /api/presets/save (fetch gate, before the request leaves): a body built from the working copy while character or
     * chat parts are laid over it is written without them. The studio's own saves are already without them.
     */
    const onSaveRequest = (_url: string, init: RequestInit | undefined): void => {
        if (!installed || !init || typeof init.body !== 'string') return;
        const parts = chatPartsNow();
        if (!parts.length) return;
        let payload: unknown;
        try {
            payload = JSON.parse(init.body);
        } catch {
            return;
        }
        if (!isDict(payload) || payload.apiId !== 'openai' || !isDict(payload.preset)) return;
        const preset = payload.preset as LayerBody;
        if (!holdsParts(preset, parts)) return;
        payload.preset = stripScoped(preset, parts);
        init.body = JSON.stringify(payload);
        const name = typeof payload.name === 'string' ? payload.name : '';
        log.info(`preset ${name || '?'} saved without the edits of this character and chat`);
        if (!name) return;
        pendingStrip.set(name, { parts: jsonCopy(parts), until: Date.now() + STRIP_WINDOW_MS });
        for (const ms of CACHE_FIX_DELAYS_MS) later(ms, () => cleanCache(name));
        later(STRIP_WINDOW_MS + 10, () => {
            const entry = pendingStrip.get(name);
            if (entry && entry.until < Date.now()) pendingStrip.delete(name);
        });
    };

    /* ------------------------------------------------------------ ST events */

    const handleBefore = (payload: unknown): void => {
        pending = null;
        if (!installed || !isDict(payload)) return;
        const name = typeof payload.presetName === 'string' ? payload.presetName : '';
        const preset = payload.preset;
        if (renaming) {
            log.debug(`preset rename in progress: no layer for ${name}`);
            return;
        }
        if (!isDict(preset) || !Object.keys(preset).length) {
            log.debug(`empty preset ${name}: no layer`);
            return;
        }
        if (suppressOnce !== null && suppressOnce === name) {
            suppressOnce = null;
            setApplied({ ...EMPTY_SCOPE_CONTEXT }, name);
            setLast(name, null);
            reportDirty = true;
            return;
        }
        // ST's own «Сохранить как» while character or chat edits were on: its cache got them, the file did not.
        const strip = pendingStrip.get(name);
        if (strip && strip.until >= Date.now() && holdsParts(preset as LayerBody, strip.parts)) {
            const clean = stripScoped(preset as LayerBody, strip.parts);
            for (const [key, value] of Object.entries(clean)) if (preset[key] !== value) preset[key] = value;
        }
        const target = loadedPart(currentScopeContext(app.host));
        setApplied(target, name);
        const parts = partsFor(name, target);
        const ops = flatOps(parts);
        if (!ops.length) {
            if (last) reportDirty = true;
            setLast(name, null);
            return;
        }
        const base: LayerBody = { ...preset };
        const { body, report } = applyScoped(base, parts);
        for (const [key, value] of Object.entries(body)) if (preset[key] !== value) preset[key] = value;
        pending = { name, base, body, ops };
        setLast(name, report);
        reportDirty = true;
        if (report.conflicts.length || report.orphaned.length) {
            log.info(
                `layer of ${name}: ${report.applied} applied, ${report.conflicts.length} conflicts, ` +
                    `${report.orphaned.length} without a place`,
            );
        }
    };

    const onBefore = (payload: unknown): void | Promise<void> => {
        if (loaded) {
            handleBefore(payload);
            return;
        }
        // Layers load at start; a preset switched in the first moments waits for them, never for long (P-178).
        return Promise.race([load(), delay(LOAD_WAIT_MS)]).then(() => {
            if (!loaded) log.warn('preset layers are still loading; the layer was not applied');
            handleBefore(payload);
        });
    };

    const remember = (name: string, fingerprint: string, base: string): void => {
        const mark = files.get(name)?.applied;
        if (mark?.fingerprint === fingerprint && mark.baseFingerprint === base) return;
        files.mutate(name, (file) => {
            file.applied = { fingerprint, baseFingerprint: base, at: Date.now() };
        });
    };

    const acknowledgeGuardian = async (): Promise<void> => {
        const guardian = app.modules.api<GuardianApi>('guardian');
        if (!guardian?.hasBaseline()) return;
        try {
            const drift = await guardian.drift();
            // Another preset than the baseline's: that switch is the user's to judge.
            if (drift.some((item) => item.path === 'preset.name')) return;
            if (!drift.some((item) => item.group === 'preset')) return;
            await guardian.acknowledge(PRESET_PATHS);
        } catch (error) {
            log.debug('guardian acknowledge failed', error);
        }
    };

    const onAfter = (): void => {
        const done = pending;
        pending = null;
        if (reportDirty) {
            reportDirty = false;
            emit();
        }
        if (!done || !installed) return;
        // The mark of the page-load check lives in the global layer file: only a base with a global layer has one.
        if (!opsOf(done.name).length) return;
        const working = workingSync() ?? done.body;
        remember(done.name, layerFingerprint(working, done.ops), baseFingerprint(savedSync(done.name) ?? done.base));
        void acknowledgeGuardian();
    };

    /** The character and chat parts of the open card and chat follow a rename (other cards and chats do not). */
    const renameScopes = async (oldName: string, newName: string): Promise<void> => {
        for (const scope of CHAT_SCOPES) {
            const owner = scopeOwner(applied, scope);
            const doc = owner ? scoped.get(scope as ScopeKind, owner) : undefined;
            if (!owner || !doc || (!doc.layers[oldName] && doc.binding?.preset !== oldName)) continue;
            await scoped.mutate(scope as ScopeKind, owner, (next) => {
                const layer = next.layers[oldName];
                if (layer) {
                    next.layers[newName] = layer;
                    delete next.layers[oldName];
                }
                if (next.binding?.preset === oldName) next.binding = { ...next.binding, preset: newName };
            });
        }
        try {
            const slice = settingsSlice();
            const value = slice.scopeApplied;
            if (isDict(value) && value.base === oldName) {
                slice.scopeApplied = { ...value, base: newName };
                app.settings.save();
            }
        } catch (error) {
            log.debug('applied scope not renamed', error);
        }
    };

    const renamed = (oldName: string, newName: string): void => {
        void renameScopes(oldName, newName).catch((error: unknown) =>
            log.warn('scopes did not follow a rename', error),
        );
        if (!files.rename(oldName, newName)) return;
        log.info(`layer moved from ${oldName} to ${newName}`);
        if (last?.name === oldName) last = { name: newName, report: last.report };
        emit();
    };

    const onRenameBefore = (payload: unknown): void => {
        if (!isDict(payload) || payload.apiId !== 'openai') return;
        renaming = {
            oldName: typeof payload.oldName === 'string' ? payload.oldName : '',
            newName: typeof payload.newName === 'string' ? payload.newName : '',
        };
        if (renameTimer) clearTimeout(renameTimer);
        renameTimer = setTimeout(() => {
            renaming = null;
            renameTimer = null;
        }, RENAME_TIMEOUT_MS);
    };

    const onRenamed = (payload: unknown): void => {
        if (!isDict(payload) || payload.apiId !== 'openai') return;
        renaming = null;
        if (renameTimer) clearTimeout(renameTimer);
        renameTimer = null;
        const oldName = typeof payload.oldName === 'string' ? payload.oldName : '';
        const newName = typeof payload.newName === 'string' ? payload.newName : '';
        if (!oldName || !newName) return;
        // ST then saves the working copy (with the layer) under the new name; apply is idempotent on it.
        if (loaded) renamed(oldName, newName);
        else void load().then(() => renamed(oldName, newName));
    };

    const offer = (name: string, reason: OfferReason): void => {
        // Found by Maestro at page load (not a reply to a click): it needs attention, so 'important', not urgent.
        app.ui.notice(t(`m34.layerSvc.offer.${reason}`, { name }), {
            importance: 'important',
            level: 'warn',
            action: {
                label: t('m34.layerSvc.offer.action'),
                run: () => {
                    void reselect(name).catch((error: unknown) => log.warn('reselect failed', error));
                },
            },
        });
    };

    /**
     * Page load (no BEFORE): the working copy should hold apply(saved base) with every part it was saved with. The
     * layer is missing when its part of the working copy differs from that; the base changed on the server when the
     * remembered base fingerprint differs and the working copy matches neither the new base nor the new base with the
     * layer stripped (a base the studio saved itself, or ST's «Обновить пресет» baking the layer in, are not changes
     * from elsewhere).
     */
    const pageLoadCheck = async (): Promise<OfferReason | null> => {
        if (checked) return null;
        checked = true;
        await load();
        await startup;
        if (!installed || !app.host.isChatCompletion()) return null;
        const name = currentName();
        if (!name || !opsOf(name).length) return null;
        const saved = await savedBody(name);
        const working = await workingBody();
        if (!saved || !working) return null;
        const parts = partsFor(name, applied);
        const ops = flatOps(parts);
        const { body: expected, report } = applyScoped(saved, parts);
        setLast(name, report);
        emit();
        const workingPrint = layerFingerprint(working, ops);
        const basePrint = baseFingerprint(saved);
        const mark = files.get(name)?.applied;
        const baseMoved = mark !== undefined && mark.baseFingerprint !== basePrint;
        let reason: OfferReason | null = null;
        if (workingPrint !== layerFingerprint(expected, ops)) {
            reason = baseMoved ? 'baseChanged' : 'layerMissing';
        } else if (baseMoved && !baseMatches(saved, working) && !baseMatches(saved, stripScoped(working, parts))) {
            reason = 'baseChanged';
        }
        if (!reason) {
            remember(name, workingPrint, basePrint);
            return null;
        }
        log.info(`layer of ${name}: ${reason}`);
        offer(name, reason);
        return reason;
    };

    const dispose = (): void => {
        if (!installed) return;
        installed = false;
        if (renameTimer) clearTimeout(renameTimer);
        renameTimer = null;
        renaming = null;
        pending = null;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        pendingStrip.clear();
        files.stop();
        if (files.hasPending()) void files.flush().catch((error: unknown) => log.warn('layer flush failed', error));
        const current = currentName();
        // Nobody would take this card's or chat's edits off on the next chat switch: they leave the working copy now.
        const parts = partsFor(current, applied, CHAT_SCOPES).filter((part) => part.ops.length > 0);
        const working = parts.length ? workingSync() : null;
        if (working && typeof store?.syncWorking === 'function') {
            void store
                .syncWorking(stripScoped(working, parts) as PresetBody)
                .catch((error: unknown) => log.warn('character and chat edits stayed in the working copy', error));
        }
        if (current) setApplied({ ...EMPTY_SCOPE_CONTEXT }, current);
        if (!current || !allOps(current).length) return;
        // P11: the layer stays in the working copy until the next preset change.
        try {
            app.ui.notice(t('m34.layerSvc.dispose.notice', { name: current }), {
                level: 'info',
                action: {
                    label: t('m34.layerSvc.dispose.action'),
                    run: () => {
                        void prepareDisable('reselectBase').catch((error: unknown) =>
                            log.warn('reselect without the layer failed', error),
                        );
                    },
                },
            });
        } catch (error) {
            log.debug('dispose notice failed', error);
        }
    };

    /** Finds the op at an index of `get(base).ops`. */
    const locate = (
        base: string,
        index: number,
    ): { op: DomainOp; scope: LayerScope; owner: string | null; local: number } | null => {
        let offset = index;
        for (const part of partsFor(base, applied)) {
            if (offset < part.ops.length) {
                const op = part.ops[offset];
                if (!op) return null;
                const owner = part.scope === 'global' ? null : scopeOwner(applied, part.scope);
                return { op, scope: part.scope, owner, local: offset };
            }
            offset -= part.ops.length;
        }
        return null;
    };

    /* ------------------------------------------------------------ the API */

    const api: PresetLayerApi = {
        get(base: string, options?: { scope?: LayerScope }): Layer | null {
            const ops: ScopedLayerOp[] = [];
            let updatedAt = 0;
            for (const scope of options?.scope ? [options.scope] : SCOPES) {
                if (scope === 'global') {
                    const file = files.get(base);
                    if (!file?.ops.length) continue;
                    updatedAt = Math.max(updatedAt, file.updatedAt);
                    for (const op of file.ops) ops.push({ ...(jsonCopy(op) as LayerOp), scope: 'global' });
                    continue;
                }
                const owner = scopeOwner(applied, scope);
                const entry = owner ? scoped.get(scope as ScopeKind, owner)?.layers[base] : undefined;
                if (!owner || !entry?.ops.length) continue;
                updatedAt = Math.max(updatedAt, entry.updatedAt);
                for (const op of entry.ops) ops.push({ ...(jsonCopy(op) as LayerOp), scope, owner });
            }
            return ops.length ? { base, ops, updatedAt } : null;
        },

        async record(base: string, op: LayerOp, scope: LayerScope = 'global'): Promise<void> {
            await load();
            const error = validateOp(op);
            if (error) throw new Error(`preset layer: ${error}`);
            const owner = ownerOf(scope);
            await savedBody(base);
            const body = bodyBelow(base, scope);
            const current = opsIn(base, scope, owner);
            let incoming = withOrigins(plainOp(op as DomainOp), body);
            if (incoming.op === 'add') {
                incoming = ownIdentifier(current, incoming, body);
            } else if (incoming.op !== 'key') {
                const id = incoming.identifier;
                const own = current.some((item) => item.op === 'add' && item.prompt.identifier === id);
                if (!own && body && !baseHas(body, id)) {
                    throw new Error(`preset layer: no block ${id} in ${base}`);
                }
                if (incoming.op === 'edit' && !own && !incoming.baseHash) {
                    throw new Error(`preset layer: the base text of ${id} is unknown`);
                }
            }
            const merged = mergeOp(current, incoming);
            if (!merged.before && !merged.after) return;
            const change = incoming;
            const summary = recordSummary(base, change, scope);
            await mutateOps(base, scope, owner, (ops) => mergeOp(ops, change).ops);
            await journal(summary, base, [
                { key: merged.key, index: merged.index, before: merged.before, after: merged.after, scope, owner },
            ]);
            refreshReport(base);
            emit();
        },

        async remove(base: string, index: number): Promise<void> {
            await load();
            const found = locate(base, index);
            if (!found) return;
            const key = opKey(found.op);
            const summary = removeSummary(base, found.op, found.scope);
            await mutateOps(base, found.scope, found.owner, (ops) => setOpAt(ops, key, null));
            await journal(summary, base, [
                { key, index: found.local, before: found.op, after: null, scope: found.scope, owner: found.owner },
            ]);
            refreshReport(base);
            emit();
        },

        apply(base: string, body: PresetBody): { body: PresetBody; report: LayerApplyReport } {
            const parts = partsFor(base, applied);
            if (!flatOps(parts).length) return { body, report: emptyReport() };
            return applyScoped(body as LayerBody, parts) as { body: PresetBody; report: LayerApplyReport };
        },

        strip(base: string, body: PresetBody, scopes?: readonly LayerScope[]): PresetBody {
            const parts = partsFor(base, applied, scopes ?? SCOPES);
            return flatOps(parts).length ? (stripScoped(body as LayerBody, parts) as PresetBody) : body;
        },

        async resolveConflict(base, identifier, choice, scope: LayerScope = 'global'): Promise<void> {
            await load();
            const owner = ownerOf(scope);
            const ops = opsIn(base, scope, owner);
            const index = ops.findIndex(
                (op) =>
                    (op.op === 'edit' && op.identifier === identifier) ||
                    (op.op === 'add' && op.prompt.identifier === identifier),
            );
            const op = ops[index];
            if (!op) throw new Error(`preset layer: no op for ${identifier} in ${base}`);
            await savedBody(base);
            const body = bodyBelow(base, scope);
            const block = body ? findPrompt(body, identifier) : undefined;
            const known =
                last?.name === base
                    ? last.report.conflicts.find(
                          (c) =>
                              c.identifier === identifier &&
                              ((c as { scope?: LayerScope }).scope ?? 'global') === scope,
                      )
                    : undefined;
            const newBase = block ? contentOf(block) : known?.newBase;
            if (newBase === undefined) throw new Error(`preset layer: the base text of ${identifier} is unknown`);
            const next = resolveOp(op, choice, newBase);
            const oldKey = opKey(op);
            const nextKey = next ? opKey(next) : oldKey;
            const summary =
                t('m34.layerSvc.journal.resolve', { name: base, block: blockName(base, identifier) }) +
                scopeSuffix(scope);
            const changes: OpChange[] = [];
            if (next && nextKey === oldKey) {
                changes.push({ key: oldKey, index, before: op, after: next, scope, owner });
            } else {
                changes.push({ key: oldKey, index, before: op, after: null, scope, owner });
                if (next) {
                    const existing = ops.find((item) => opKey(item) === nextKey) ?? null;
                    changes.push({ key: nextKey, index, before: existing, after: next, scope, owner });
                }
            }
            await mutateOps(base, scope, owner, (list) => {
                if (next && nextKey === oldKey) return setOpAt(list, oldKey, next);
                const without = setOpAt(list, oldKey, null);
                return next ? setOpAt(without, nextKey, next, index) : without;
            });
            await journal(summary, base, changes);
            // The working copy of the current preset shows the chosen text right away.
            if (store && base === currentName()) {
                const mine =
                    op.op === 'edit'
                        ? (op.patch.content ?? newBase)
                        : op.op === 'add'
                          ? (op.prompt.content ?? '')
                          : newBase;
                const text = choice === 'newBase' ? newBase : choice === 'mine' ? mine : choice.text;
                const current = findPrompt(workingSync(), identifier);
                if (current && contentOf(current) !== text) {
                    try {
                        await store.updatePrompt(identifier, { content: text } as Partial<PresetPrompt>);
                    } catch (error) {
                        log.warn(`the working copy of ${identifier} was not updated`, error);
                    }
                }
            }
            refreshReport(base);
            emit();
        },

        async migrateFrom(
            base: string,
            reference: PresetBody,
            edited: PresetBody,
            scope: LayerScope = 'global',
        ): Promise<LayerApplyReport> {
            await load();
            const owner = ownerOf(scope);
            const plan = planMigration(reference, edited);
            let ops = opsIn(base, scope, owner);
            const changes: OpChange[] = [];
            for (const op of plan.ops) {
                const key = opKey(op);
                const index = ops.findIndex((item) => opKey(item) === key);
                const before = index >= 0 ? (ops[index] ?? null) : null;
                changes.push({ key, index: index >= 0 ? index : ops.length, before, after: op, scope, owner });
                ops = setOpAt(ops, key, op);
            }
            if (plan.ops.length) {
                const planned = plan.ops;
                await mutateOps(base, scope, owner, (list) => {
                    let next = list;
                    for (const op of planned) next = setOpAt(next, opKey(op), op);
                    return next;
                });
                const summary =
                    tPlural(app.i18n, 'm34.layerSvc.journal.migrate', plan.ops.length, { name: base }) +
                    scopeSuffix(scope);
                await journal(summary, base, changes);
            }
            refreshReport(base);
            emit();
            const { report } = applyLayer(reference, ops);
            return { ...report, removed: plan.removed };
        },

        async transfer(fromBase: string, toBase: string): Promise<LayerApplyReport> {
            await load();
            const source = opsOf(fromBase);
            if (!source.length || fromBase === toBase) return emptyReport();
            const [from, to] = await Promise.all([savedBody(fromBase), savedBody(toBase)]);
            const moved = transferOps(source, from, to);
            const prepared = moved.ops.map((op) => withOrigins(op, to));
            let ops = opsOf(toBase);
            const changes: OpChange[] = [];
            for (const op of prepared) {
                const result = mergeOp(ops, op);
                if (result.before || result.after) {
                    changes.push({
                        key: result.key,
                        index: result.index,
                        before: result.before,
                        after: result.after,
                        scope: 'global',
                        owner: null,
                    });
                }
                ops = result.ops;
            }
            if (prepared.length) {
                files.mutate(toBase, (file) => {
                    for (const op of prepared) file.ops = mergeOp(file.ops, op).ops;
                });
                await journal(
                    tPlural(app.i18n, 'm34.layerSvc.journal.transfer', prepared.length, {
                        name: toBase,
                        from: fromBase,
                    }),
                    toBase,
                    changes,
                );
            }
            refreshReport(toBase);
            emit();
            const report = to ? applyLayer(to, ops).report : emptyReport();
            const orphaned = [...moved.orphaned];
            for (const op of report.orphaned) {
                if (!orphaned.some((item) => opKey(item) === opKey(op))) orphaned.push(op);
            }
            return { applied: prepared.length, conflicts: report.conflicts, orphaned };
        },

        importForeign(body: PresetBody): PresetPrompt[] {
            return splitForeign(body);
        },

        lastReport(): LayerApplyReport | null {
            return last && last.name === currentName() ? jsonCopy(last.report) : null;
        },

        onChange(listener: (change?: LayerChange) => void): Unsubscribe {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        ready: load,

        flush: async () => {
            await files.flush();
            await scoped.flush();
        },

        planMigration(reference: PresetBody, edited: PresetBody): { ops: LayerOp[]; report: LayerApplyReport } {
            const plan = planMigration(reference, edited);
            const { report } = applyLayer(reference, plan.ops);
            return { ops: plan.ops, report: { ...report, removed: plan.removed } };
        },

        reselect,

        prepareDisable,

        context: () => info(),

        whenContext: () => contextChain.then(() => info()),

        below(base: string, scope: LayerScope): PresetBody | null {
            return bodyBelow(base, scope) as PresetBody | null;
        },

        async moveOp(base: string, index: number, scope: LayerScope): Promise<void> {
            await load();
            const found = locate(base, index);
            if (!found || found.scope === scope) return;
            const toOwner = ownerOf(scope);
            const key = opKey(found.op);
            // Out of the old scope first: the base below the new scope must not hold the op itself.
            await mutateOps(base, found.scope, found.owner, (ops) => setOpAt(ops, key, null));
            await savedBody(base);
            const incoming = withOrigins(rebaseOp(found.op), bodyBelow(base, scope));
            const merged = mergeOp(opsIn(base, scope, toOwner), incoming);
            await mutateOps(base, scope, toOwner, (ops) => mergeOp(ops, incoming).ops);
            const what = opBlock(base, found.op) || paramName(found.op.op === 'key' ? found.op.key : '');
            await journal(
                t(`m34.layerSvc.journal.moveScope.${scope}`, {
                    name: base,
                    block: what,
                    character: applied.characterName ?? applied.avatar ?? '',
                }),
                base,
                [
                    {
                        key,
                        index: found.local,
                        before: found.op,
                        after: null,
                        scope: found.scope,
                        owner: found.owner,
                    },
                    {
                        key: merged.key,
                        index: merged.index,
                        before: merged.before,
                        after: merged.after,
                        scope,
                        owner: toOwner,
                    },
                ],
            );
            refreshReport(base);
            emit();
        },

        bindings(): PresetBindings {
            const character = applied.avatar
                ? (scoped.get('character', applied.avatar)?.binding?.preset ?? null)
                : null;
            const chat = applied.chatId ? (scoped.get('chat', applied.chatId)?.binding?.preset ?? null) : null;
            const active = chat
                ? { scope: 'chat' as const, preset: chat }
                : character
                  ? { scope: 'character' as const, preset: character }
                  : null;
            return { character, chat, active, context: info() };
        },

        async bind(scope: 'character' | 'chat', preset: string | null): Promise<void> {
            await contextChain;
            const owner = ownerOf(scope);
            if (!owner) return;
            await scoped.loadOne(scope, owner);
            const before = scoped.get(scope, owner)?.binding?.preset ?? null;
            const next = preset?.trim() || null;
            if (before === next) return;
            await scoped.mutate(scope, owner, (doc) => {
                doc.binding = next ? { preset: next, at: Date.now() } : null;
            });
            const who = applied.characterName ?? applied.avatar ?? '';
            const summary = next
                ? t(`m34.layerSvc.journal.bind.${scope}`, { name: next, character: who })
                : t(`m34.layerSvc.journal.unbind.${scope}`, { name: before ?? '', character: who });
            try {
                await app.journal.record({
                    module: MODULE_ID,
                    kind: BINDING_JOURNAL_KIND,
                    summary,
                    changes: [{ target: BINDING_TARGET, ref: { scope, owner }, before, after: next }],
                });
            } catch (error) {
                log.warn('binding was not journaled', error);
            }
            emit('binding');
        },
    };

    let disposers: Unsubscribe[] = [];
    // The handle is the API object itself (module.ts exposes what the factory returns and owns its dispose()), and
    // also carries `api` and `install()` for callers that own the disposers themselves.
    const handle: PresetLayerHandle = Object.assign(api, {
        api,
        install(): Unsubscribe[] {
            if (installed) return [];
            installed = true;
            checked = false;
            app.journal.registerUndo(LAYER_TARGET, undoChange);
            app.journal.registerUndo(BINDING_TARGET, undoBinding);
            void load();
            applied = persistedApplied();
            startup = scoped.load(applied).catch((error: unknown) => log.warn('scopes could not be loaded', error));
            const events = app.host.events;
            const on = (key: string, raw: string, handler: (...args: unknown[]) => unknown): Unsubscribe =>
                events.on(events.name(key) ?? raw, handler);
            const check = () => {
                void pageLoadCheck().catch((error: unknown) => log.warn('page-load layer check failed', error));
            };
            const sync = () => {
                void syncContext().catch((error: unknown) => log.warn('scopes of the chat were not laid on', error));
            };
            disposers = [
                on('OAI_PRESET_CHANGED_BEFORE', 'oai_preset_changed_before', onBefore),
                on('OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after', onAfter),
                on('PRESET_RENAMED_BEFORE', 'preset_renamed_before', onRenameBefore),
                on('PRESET_RENAMED', 'preset_renamed', onRenamed),
                // APP_READY fires a late listener at once (auto-fire), so a module enabled later is checked too.
                on('APP_READY', 'app_ready', check),
                on('SETTINGS_LOADED', 'settings_loaded', check),
                app.bus.on('chat:changed', sync),
                app.host.fetchGate.beforeRequest(SAVE_URL_RE, onSaveRequest),
                dispose,
            ];
            sync();
            return [...disposers];
        },
        dispose(): void {
            for (const off of disposers.splice(0).reverse()) {
                try {
                    off();
                } catch (error) {
                    log.warn('preset layer dispose step failed', error);
                }
            }
        },
    });
    return handle;
}

/** The base has the block (in its prompts, or in the order the layer works on). */
function baseHas(body: LayerBody, identifier: string): boolean {
    return (
        findPrompt(body, identifier) !== undefined ||
        effectiveOrder(body).some((item) => item.identifier === identifier)
    );
}
