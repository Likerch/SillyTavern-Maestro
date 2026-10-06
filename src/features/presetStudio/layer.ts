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
import { tPlural } from '../../core/labels';
import {
    applyLayer,
    contentOf,
    effectiveOrder,
    emptyReport,
    findPrompt,
    isDict,
    stripLayer,
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
import { jsonCopy, valuesEqual } from '../../domain/settings-diff';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { GuardianApi } from '../guardian/api';
import type { Layer, LayerApplyReport, LayerOp, PresetLayerApi } from './layer-api';
import { LayerFiles } from './layer-files';
import { LAYER_STRINGS } from './layer-strings';
import { paramLabel } from './param-labels';
import type { PresetBody, PresetPrompt, PresetStore } from './store-api';

export const PRESET_LAYER_KEY = 'presetLayer';
/** Journal target of layer changes (undo puts the op back). */
export const LAYER_TARGET = 'preset-layer';
export const LAYER_JOURNAL_KIND = 'preset.layer';
const MODULE_ID = 'M34';
/** Longest wait of the BEFORE handler for layers still loading at start. */
const LOAD_WAIT_MS = 2000;
/** A rename that never reports PRESET_RENAMED (an error in between) must not block the layer for good. */
const RENAME_TIMEOUT_MS = 30_000;
/** M4 baseline paths a layer application changes on purpose. */
const PRESET_PATHS = ['preset.order', 'preset.toggles', 'preset.roles', 'preset.contents', 'preset.body'];

type Dict = Record<string, unknown>;
type OfferReason = 'layerMissing' | 'baseChanged';

interface LayerChange {
    key: string;
    index: number;
    before: DomainOp | null;
    after: DomainOp | null;
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

export function createPresetLayer(app: App, log: Logger, store?: PresetStore): PresetLayerHandle {
    app.i18n.register(LAYER_STRINGS);
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const listeners = new Set<() => void>();
    let saveErrorShown = false;
    const files = new LayerFiles(app.files, log, {
        onError: (base) => {
            if (saveErrorShown) return;
            saveErrorShown = true;
            app.ui.notice(t('m34.layerSvc.saveFailed', { name: base }), { level: 'error' });
        },
    });

    let loading: Promise<void> | null = null;
    let loaded = false;
    let installed = false;
    let openai: Dict | null = null;
    let renaming: { oldName: string; newName: string } | null = null;
    let renameTimer: ReturnType<typeof setTimeout> | null = null;
    /** What BEFORE applied, for AFTER. */
    let pending: { name: string; base: LayerBody; body: LayerBody } | null = null;
    /** BEFORE changed the report: AFTER tells the listeners (the working copy is final by then). */
    let reportDirty = false;
    let last: { name: string; report: DomainReport } | null = null;
    /** «Подготовить к отключению»: the next BEFORE of this name loads the base without the layer. */
    let suppressOnce: string | null = null;
    let checked = false;

    /* ------------------------------------------------------------ plumbing */

    const emit = (): void => {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (error) {
                log.error('preset layer listener failed', error);
            }
        }
    };

    const opsOf = (base: string): DomainOp[] => files.get(base)?.ops ?? [];

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
        const ops = opsOf(base);
        const saved = savedSync(base);
        if (!ops.length) setLast(base, null);
        else if (saved) setLast(base, applyLayer(saved, ops).report);
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

    const journal = async (summary: string, base: string, changes: readonly LayerChange[]): Promise<void> => {
        if (!changes.length) return;
        try {
            await app.journal.record({
                module: MODULE_ID,
                kind: LAYER_JOURNAL_KIND,
                summary,
                changes: changes.map((change) => ({
                    target: LAYER_TARGET,
                    ref: { base, key: change.key, index: change.index },
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
        if (!base || !key) return false;
        const current = opsOf(base).find((op) => opKey(op) === key) ?? null;
        if (!valuesEqual(current, change.after ?? null)) {
            log.warn(`layer op ${key} of ${base} changed after this action; not undone`);
            return false;
        }
        const before =
            change.before !== null && validateOp(change.before) === null ? (change.before as DomainOp) : null;
        const index = typeof ref.index === 'number' ? ref.index : undefined;
        files.mutate(base, (file) => {
            file.ops = setOpAt(file.ops, key, before, index);
        });
        refreshReport(base);
        emit();
        return true;
    };

    /** An add op gets an identifier of its own: none given, or one the base already uses (a picked foreign block). */
    const ownIdentifier = (base: string, op: AddOp, body: LayerBody | null): AddOp => {
        const id = op.prompt.identifier;
        if (id && opsOf(base).some((item) => item.op === 'add' && item.prompt.identifier === id)) return op;
        if (id && !(body && findPrompt(body, id))) return op;
        return { ...op, prompt: { ...op.prompt, identifier: newIdentifier() } };
    };

    const ownBlock = (base: string, identifier: string): boolean =>
        opsOf(base).some((op) => op.op === 'add' && op.prompt.identifier === identifier);

    /* ------------------------------------------------------------ journal summaries */

    /** A block's name for a journal summary: the user's own block, else the base's (its identifier at worst). */
    const blockName = (base: string, identifier: string): string => {
        const own = opsOf(base).find((op): op is AddOp => op.op === 'add' && op.prompt.identifier === identifier);
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

    /** «В слое «Marinara» выключен блок «Main»»: what one recorded operation does, in words. */
    const recordSummary = (base: string, op: DomainOp): string => {
        if (op.op === 'key') return t('m34.layerSvc.journal.key', { name: base, param: paramName(op.key) });
        const what = op.op === 'toggle' ? (op.enabled ? 'on' : 'off') : op.op;
        return t(`m34.layerSvc.journal.${what}`, { name: base, block: opBlock(base, op) });
    };

    const removeSummary = (base: string, op: DomainOp): string =>
        op.op === 'key'
            ? t('m34.layerSvc.journal.removeKey', { name: base, param: paramName(op.key) })
            : t('m34.layerSvc.journal.remove', { name: base, block: opBlock(base, op) });

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
            setLast(name, null);
            reportDirty = true;
            return;
        }
        const ops = opsOf(name);
        if (!ops.length) {
            if (last) reportDirty = true;
            setLast(name, null);
            return;
        }
        const base: LayerBody = { ...preset };
        const { body, report } = applyLayer(base, ops);
        for (const [key, value] of Object.entries(body)) if (preset[key] !== value) preset[key] = value;
        pending = { name, base, body };
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
        const ops = opsOf(done.name);
        if (!ops.length) return;
        const working = workingSync() ?? done.body;
        remember(done.name, layerFingerprint(working, ops), baseFingerprint(savedSync(done.name) ?? done.base));
        void acknowledgeGuardian();
    };

    const renamed = (oldName: string, newName: string): void => {
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
     * Page load (no BEFORE): the working copy should hold apply(saved base). The layer is missing when its part of
     * the working copy differs from that; the base changed on the server when the remembered base fingerprint
     * differs and the working copy matches neither the new base nor the new base with the layer stripped (a base the
     * studio saved itself, or ST's «Обновить пресет» baking the layer in, are not changes from elsewhere).
     */
    const pageLoadCheck = async (): Promise<OfferReason | null> => {
        if (checked) return null;
        checked = true;
        await load();
        if (!installed || !app.host.isChatCompletion()) return null;
        const name = currentName();
        const ops = opsOf(name);
        if (!name || !ops.length) return null;
        const saved = await savedBody(name);
        const working = await workingBody();
        if (!saved || !working) return null;
        const { body: expected, report } = applyLayer(saved, ops);
        setLast(name, report);
        emit();
        const workingPrint = layerFingerprint(working, ops);
        const basePrint = baseFingerprint(saved);
        const mark = files.get(name)?.applied;
        const baseMoved = mark !== undefined && mark.baseFingerprint !== basePrint;
        let reason: OfferReason | null = null;
        if (workingPrint !== layerFingerprint(expected, ops)) {
            reason = baseMoved ? 'baseChanged' : 'layerMissing';
        } else if (baseMoved && !baseMatches(saved, working) && !baseMatches(saved, stripLayer(working, ops))) {
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
        files.stop();
        if (files.hasPending()) void files.flush().catch((error: unknown) => log.warn('layer flush failed', error));
        const current = currentName();
        if (!current || !opsOf(current).length) return;
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

    /* ------------------------------------------------------------ the API */

    const api: PresetLayerApi = {
        get(base: string): Layer | null {
            const file = files.get(base);
            if (!file || !file.ops.length) return null;
            return { base, ops: jsonCopy(file.ops) as LayerOp[], updatedAt: file.updatedAt };
        },

        async record(base: string, op: LayerOp): Promise<void> {
            await load();
            const error = validateOp(op);
            if (error) throw new Error(`preset layer: ${error}`);
            const body = await savedBody(base);
            let incoming = withOrigins(op, body);
            if (incoming.op === 'add') {
                incoming = ownIdentifier(base, incoming, body);
            } else if (incoming.op !== 'key') {
                const own = ownBlock(base, incoming.identifier);
                if (!own && body && !baseHas(body, incoming.identifier)) {
                    throw new Error(`preset layer: no block ${incoming.identifier} in ${base}`);
                }
                if (incoming.op === 'edit' && !own && !incoming.baseHash) {
                    throw new Error(`preset layer: the base text of ${incoming.identifier} is unknown`);
                }
            }
            const merged = mergeOp(opsOf(base), incoming);
            if (!merged.before && !merged.after) return;
            const change = incoming;
            const summary = recordSummary(base, change);
            files.mutate(base, (file) => {
                file.ops = mergeOp(file.ops, change).ops;
            });
            await journal(summary, base, [
                { key: merged.key, index: merged.index, before: merged.before, after: merged.after },
            ]);
            refreshReport(base);
            emit();
        },

        async remove(base: string, index: number): Promise<void> {
            await load();
            const op = opsOf(base)[index];
            if (!op) return;
            const key = opKey(op);
            const summary = removeSummary(base, op);
            files.mutate(base, (file) => {
                file.ops = setOpAt(file.ops, key, null);
            });
            await journal(summary, base, [{ key, index, before: op, after: null }]);
            refreshReport(base);
            emit();
        },

        apply(base: string, body: PresetBody): { body: PresetBody; report: LayerApplyReport } {
            const ops = opsOf(base);
            if (!ops.length) return { body, report: emptyReport() };
            return applyLayer(body, ops);
        },

        strip(base: string, body: PresetBody): PresetBody {
            const ops = opsOf(base);
            return ops.length ? stripLayer(body, ops) : body;
        },

        async resolveConflict(base, identifier, choice): Promise<void> {
            await load();
            const ops = opsOf(base);
            const index = ops.findIndex(
                (op) =>
                    (op.op === 'edit' && op.identifier === identifier) ||
                    (op.op === 'add' && op.prompt.identifier === identifier),
            );
            const op = ops[index];
            if (!op) throw new Error(`preset layer: no op for ${identifier} in ${base}`);
            const body = await savedBody(base);
            const block = body ? findPrompt(body, identifier) : undefined;
            const known =
                last?.name === base ? last.report.conflicts.find((c) => c.identifier === identifier) : undefined;
            const newBase = block ? contentOf(block) : known?.newBase;
            if (newBase === undefined) throw new Error(`preset layer: the base text of ${identifier} is unknown`);
            const next = resolveOp(op, choice, newBase);
            const oldKey = opKey(op);
            const nextKey = next ? opKey(next) : oldKey;
            const summary = t('m34.layerSvc.journal.resolve', { name: base, block: blockName(base, identifier) });
            const changes: LayerChange[] = [];
            if (next && nextKey === oldKey) {
                changes.push({ key: oldKey, index, before: op, after: next });
            } else {
                changes.push({ key: oldKey, index, before: op, after: null });
                if (next) {
                    const existing = ops.find((item) => opKey(item) === nextKey) ?? null;
                    changes.push({ key: nextKey, index, before: existing, after: next });
                }
            }
            files.mutate(base, (file) => {
                if (next && nextKey === oldKey) {
                    file.ops = setOpAt(file.ops, oldKey, next);
                    return;
                }
                file.ops = setOpAt(file.ops, oldKey, null);
                if (next) file.ops = setOpAt(file.ops, nextKey, next, index);
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

        async migrateFrom(base: string, reference: PresetBody, edited: PresetBody): Promise<LayerApplyReport> {
            await load();
            const plan = planMigration(reference, edited);
            let ops = opsOf(base);
            const changes: LayerChange[] = [];
            for (const op of plan.ops) {
                const key = opKey(op);
                const index = ops.findIndex((item) => opKey(item) === key);
                const before = index >= 0 ? (ops[index] ?? null) : null;
                changes.push({ key, index: index >= 0 ? index : ops.length, before, after: op });
                ops = setOpAt(ops, key, op);
            }
            if (plan.ops.length) {
                const planned = plan.ops;
                files.mutate(base, (file) => {
                    for (const op of planned) file.ops = setOpAt(file.ops, opKey(op), op);
                });
                const summary = tPlural(app.i18n, 'm34.layerSvc.journal.migrate', plan.ops.length, { name: base });
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
            const changes: LayerChange[] = [];
            for (const op of prepared) {
                const result = mergeOp(ops, op);
                if (result.before || result.after) {
                    changes.push({ key: result.key, index: result.index, before: result.before, after: result.after });
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

        onChange(listener: () => void): Unsubscribe {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        ready: load,

        flush: () => files.flush(),

        planMigration(reference: PresetBody, edited: PresetBody): { ops: LayerOp[]; report: LayerApplyReport } {
            const plan = planMigration(reference, edited);
            const { report } = applyLayer(reference, plan.ops);
            return { ops: plan.ops, report: { ...report, removed: plan.removed } };
        },

        reselect,

        prepareDisable,
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
            void load();
            const events = app.host.events;
            const on = (key: string, raw: string, handler: (...args: unknown[]) => unknown): Unsubscribe =>
                events.on(events.name(key) ?? raw, handler);
            const check = () => {
                void pageLoadCheck().catch((error: unknown) => log.warn('page-load layer check failed', error));
            };
            disposers = [
                on('OAI_PRESET_CHANGED_BEFORE', 'oai_preset_changed_before', onBefore),
                on('OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after', onAfter),
                on('PRESET_RENAMED_BEFORE', 'preset_renamed_before', onRenameBefore),
                on('PRESET_RENAMED', 'preset_renamed', onRenamed),
                // APP_READY fires a late listener at once (auto-fire), so a module enabled later is checked too.
                on('APP_READY', 'app_ready', check),
                on('SETTINGS_LOADED', 'settings_loaded', check),
                dispose,
            ];
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
