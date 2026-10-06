// The Preset Studio window (M34, stage 5): one large ST Popup, full screen on phones (≤1000px). Header: the preset
// select (a switch with unsaved edits asks «Сохранить / Отбросить / Отмена» first — ST would drop them silently,
// P-073), Save (into the user's layer when there is one), «Сохранить базу», Save as, Rename, Delete, Import, Export,
// «Классический редактор». Tabs: Карта, Блоки, Анализ, Условия, Слой, Версии, Параметры; the block editor is a side panel
// (an overlay on phones) with a leave guard. Data: store-api.ts / layer-api.ts / analysis-api.ts, found at run time
// (app.modules.api), so the window degrades when a part is missing. With the assistant on, «Обсудить с ассистентом» on
// the preset (header) and on every block row opens it with that preset or block attached (plan-2 §1 п. 7).
//
// Edits (EditRouter): with a layer for the current base and `editsToLayer` on, every studio edit is recorded in the
// layer (layer.record) and applied to the working copy through the store, so it works at once and survives a base
// update; without a layer they go straight to the store. «Сохранить базу» writes the base without the layer.
import {
    DEFAULT_PROMPT_ORDER,
    EXTERNAL_MARKERS,
    copyName,
    detachedPrompts,
    fieldsPatch,
    normalizePrompt,
    promptDepth,
    promptName,
    promptOrder,
    promptRole,
    promptText,
    sideEffectMacros,
    userFlagsPatch,
} from '../../domain/preset-ui-blocks';
import type { BlockFields } from '../../domain/preset-ui-blocks';
import {
    buildPromptListExport,
    parsePresetBody,
    parsePromptList,
    planPromptListImport,
    promptListFileName,
} from '../../domain/preset-ui-io';
import { isMaestroFlag } from '../../domain/preset-conditional-syntax';
import { anchorFor, moveItem, moveOps, sameOrder } from '../../domain/preset-ui-order';
import { stableHash } from '../../domain/hash';
import { tabs } from '../../ui/components/tabs';
import type { TabsHandle } from '../../ui/components/tabs';
import { append, button, el, icon, prefersReducedMotion } from '../../ui/components/dom';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { AssistantApi } from '../assistant/api';
import type { MapSlot, PresetAnalysisApi, PresetFinding, ProviderHint } from './analysis-api';
import { Dialogs, downloadJson } from './dialogs';
import type { LayerApplyReport, LayerConflict, LayerOp, LayerScope, PresetLayerApi } from './layer-api';
import type { NeighbourPromptsApi } from '../neighbourPrompts/api';
import { renderNeighboursPanel } from './view-neighbours';
import { availableScopes, bindingText, scopeLabel } from './view-scopes';
import type { PmInfo } from './launcher';
import type { PresetBody, PresetPrompt, PresetStore, PresetVersion } from './store-api';
import { renderAnalysisPanel } from './view-analysis';
import { emptyBlocksState, renderBlocksPanel } from './view-blocks';
import type { BlocksActions, BlocksModel } from './view-blocks';
import { renderBlockEditor } from './view-editor';
import type { EditorHandle } from './view-editor';
import { renderLayerPanel, renderMigrationPreview } from './view-layer';
import type { ForeignPick, LayerActions, LayerModel } from './view-layer';
import { renderMapPanel } from './view-map';
import { renderParamsPanel } from './view-params';
import { renderScenariosPanel } from './view-scenarios';
import type { ScenariosModel } from './view-scenarios';
import { renderVersionsPanel } from './view-versions';
import type { ScenariosApi } from '../scenarios/api';
import {
    conditionalFindings,
    conditionalRows,
    directorCurrentFlags,
    directorFlagsOn,
    mechanicsFlagsOn,
    flagCatalogue,
    flagHint,
    knownFlags,
    flagLabel,
    macroEngineState,
} from './conditional';
import type { ConditionalRow } from './conditional';
import { renderConditionalPanel } from './view-conditional';
import type { FlagOption } from './view-conditional';

/* ------------------------------------------------------------------ settings and services */

export type StudioTab = 'map' | 'blocks' | 'analysis' | 'conditional' | 'layer' | 'versions' | 'params' | 'neighbours';
export const STUDIO_TABS: readonly StudioTab[] = [
    'map',
    'blocks',
    'analysis',
    'conditional',
    'layer',
    'versions',
    'params',
    'neighbours',
];

export interface PresetStudioSettings {
    /** Hide ST's Prompt Manager behind the launcher (off until the parity table is green, like the Lore Studio). */
    replacePromptManager: boolean;
    /** Studio edits go to the user's layer when the current base has one. */
    editsToLayer: boolean;
    /** The tab the window opens on. */
    tab: StudioTab;
    /**
     * What the working copy holds of the layer's character and chat parts (written by the layer, layer.ts): page load
     * has no OAI_PRESET_CHANGED_BEFORE, so the first chat switch must know what to strip.
     */
    scopeApplied?: { base: string; avatar: string | null; chatId: string | null } | null;
    /** The preset that was active before a bound chat selected its own (binding.ts brings it back). */
    bindingRestore?: string | null;
}

export function defaultPresetStudioSettings(): PresetStudioSettings {
    return { replacePromptManager: false, editsToLayer: true, tab: 'blocks', scopeApplied: null, bindingRestore: null };
}

/** The parts of the studio built by other agents, found at run time (absent → the window degrades). */
export interface PresetServices {
    store(): PresetStore | null;
    layer(): PresetLayerApi | null;
    analysis(): PresetAnalysisApi | null;
    /** The generation-scenario engine (scenarios/api.ts): parameters per scenario (M34 п. 9). */
    scenarios(): ScenariosApi | null;
    /** Neighbour prompts (M36, neighbourPrompts/api.ts): the «Промпты соседей» tab. */
    neighbours?(): NeighbourPromptsApi | null;
}

export function servicesOf(app: App): PresetServices {
    return {
        store: () => app.modules.api<PresetStore>('presetStore') ?? null,
        layer: () => app.modules.api<PresetLayerApi>('presetLayer') ?? null,
        analysis: () => app.modules.api<PresetAnalysisApi>('presetAnalysis') ?? null,
        scenarios: () => app.modules.api<ScenariosApi>('scenarios') ?? null,
        neighbours: () => app.modules.api<NeighbourPromptsApi>('neighbourPrompts') ?? null,
    };
}

/** A new block identifier the way PM makes them (uuidv4, PM:620-630). */
export function newIdentifier(app: App): string {
    try {
        const id = app.host.ctx().uuidv4?.();
        if (typeof id === 'string' && id) return id;
    } catch {
        // fall through
    }
    return (
        globalThis.crypto?.randomUUID?.() ?? `maestro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    );
}

/** The layer's text fingerprint (preset-layer-apply.ts textHash: line ends normalized). */
export function baseHashOf(text: string): string {
    return stableHash(text.replace(/\r\n/g, '\n'));
}

/* ------------------------------------------------------------------ edit routing */

export interface RouterDeps {
    services: PresetServices;
    settings: PresetStudioSettings;
    /** Bases the user started a layer for in this session (the first record creates it). */
    started: Set<string>;
    newId(): string;
    /** Where new edits go (the studio's scope switch, default «везде»). */
    scope?(): LayerScope;
}

/**
 * Where a studio edit goes. Layer mode (a layer for the current base, or one started in this session, and
 * `editsToLayer` on): the edit is recorded in the layer, then applied to the working copy through the store. A block
 * that is neither in the saved base nor added by the layer (made outside the studio and not saved yet) cannot be
 * recorded (the layer has nothing to anchor it to): its edits go to the working copy only.
 */
export class EditRouter {
    constructor(private readonly deps: RouterDeps) {}

    private store(): PresetStore {
        const store = this.deps.services.store();
        if (!store) throw new Error('preset store is not available');
        return store;
    }

    base(): string {
        return this.store().current();
    }

    /** Where new edits go: the studio's choice when the chat open now has that scope, else «везде». */
    scope(): LayerScope {
        const wanted = this.deps.scope?.() ?? 'global';
        if (wanted === 'global') return 'global';
        const context = this.deps.services.layer()?.context?.() ?? null;
        return availableScopes(context).includes(wanted) ? wanted : 'global';
    }

    /** The layer, when edits go there now. */
    layer(): PresetLayerApi | null {
        const layer = this.deps.services.layer();
        if (!layer || !this.deps.settings.editsToLayer) return null;
        const store = this.deps.services.store();
        if (!store) return null;
        const base = store.current();
        return layer.get(base) !== null || this.deps.started.has(base) || this.scope() !== 'global' ? layer : null;
    }

    layerMode(): boolean {
        return this.layer() !== null;
    }

    /** What an edit of `scope` is made on: the saved base with the lower scopes (the layer stripped without a cache). */
    private baseBody(layer: PresetLayerApi, scope: LayerScope = this.scope()): PresetBody {
        const store = this.store();
        const base = store.current();
        if (scope !== 'global') {
            const below = layer.below?.(base, scope);
            if (below) return below;
        }
        return store.saved(base) ?? layer.strip(base, store.working());
    }

    /** The scope whose layer added this block (null: a block of the base). */
    private ownerScope(identifier: string): LayerScope | null {
        const layer = this.deps.services.layer();
        const store = this.deps.services.store();
        if (!layer || !store) return null;
        const own = (layer.get(store.current())?.ops ?? []).find(
            (op) => op.op === 'add' && op.prompt.identifier === identifier,
        );
        return own ? (own.scope ?? 'global') : null;
    }

    /** True when the layer added this block. */
    ownBlock(identifier: string): boolean {
        return this.ownerScope(identifier) !== null;
    }

    /** The scope an edit of this block is recorded in: an own block's own scope, else where new edits go. */
    private scopeFor(identifier: string): LayerScope {
        return this.ownerScope(identifier) ?? this.scope();
    }

    /** The layer when this block can be recorded in it (in the base below the scope, or a block of the layer). */
    private layerFor(identifier: string): PresetLayerApi | null {
        const layer = this.layer();
        if (!layer) return null;
        if (this.ownBlock(identifier)) return layer;
        return (this.baseBody(layer).prompts ?? []).some((prompt) => prompt.identifier === identifier) ? layer : null;
    }

    /** The base text a block edit is made on ('' for the layer's own blocks). */
    baseText(identifier: string, layer: PresetLayerApi, scope: LayerScope = this.scope()): string {
        const prompt = (this.baseBody(layer, scope).prompts ?? []).find((item) => item.identifier === identifier);
        return prompt ? promptText(prompt) : '';
    }

    private async record(layer: PresetLayerApi, op: LayerOp, scope: LayerScope = this.scope()): Promise<void> {
        const base = this.base();
        await layer.record(base, op, scope);
        this.deps.started.add(base);
    }

    async editPrompt(identifier: string, patch: Partial<PresetPrompt>): Promise<void> {
        if (!Object.keys(patch).length) return;
        const layer = this.layerFor(identifier);
        if (layer) {
            const scope = this.scopeFor(identifier);
            const baseText = this.baseText(identifier, layer, scope);
            await this.record(
                layer,
                { op: 'edit', identifier, patch, baseHash: baseHashOf(baseText), baseText },
                scope,
            );
        }
        await this.store().updatePrompt(identifier, patch);
    }

    async toggle(identifiers: string[], enabled: boolean): Promise<void> {
        if (!identifiers.length) return;
        for (const identifier of identifiers) {
            const layer = this.layerFor(identifier);
            if (layer) await this.record(layer, { op: 'toggle', identifier, enabled }, this.scopeFor(identifier));
        }
        await this.store().setEnabled(identifiers, enabled);
    }

    /** A new order of the listed blocks (the store keeps unlisted entries at the end, it never detaches). */
    async reorder(before: string[], after: string[], moved: string[] = []): Promise<void> {
        if (sameOrder(before, after)) return;
        for (const move of moveOps(before, after, moved)) {
            const layer = this.layerFor(move.identifier);
            if (layer) await this.record(layer, { op: 'move', ...move }, this.scopeFor(move.identifier));
        }
        await this.store().reorder(after);
    }

    /** Adds a user block after `after` (or at the start) and returns its identifier. */
    async add(prompt: PresetPrompt, after: string | null, enabled: boolean): Promise<string> {
        const store = this.store();
        const block = normalizePrompt({ ...prompt, identifier: prompt.identifier || this.deps.newId() });
        const layer = this.layer();
        if (layer) {
            await this.record(layer, {
                op: 'add',
                prompt: block,
                anchor: after ? { kind: 'after', identifier: after } : { kind: 'start' },
                enabled,
            });
        }
        const identifier = await store.addPrompt({ ...block, enabled }, after ?? undefined);
        const row = store.prompts().find((item) => item.item.identifier === identifier);
        if (row && row.item.enabled !== enabled) await store.setEnabled([identifier], enabled);
        return identifier;
    }

    /**
     * Deletes a user block. In layer mode a block the layer added loses its operations; a block of the base cannot be
     * deleted by the layer (there is no such operation) — it is switched off in the layer instead ('disabled').
     */
    async remove(identifier: string): Promise<'removed' | 'disabled'> {
        const store = this.store();
        const layer = this.layer();
        if (layer) {
            const base = this.base();
            const ops = layer.get(base)?.ops ?? [];
            if (!this.ownBlock(identifier)) {
                if (this.layerFor(identifier)) {
                    await this.toggle([identifier], false);
                    return 'disabled';
                }
            } else {
                const indices = ops
                    .map((op, index) => ({ op, index }))
                    .filter(({ op }) => opTarget(op) === identifier)
                    .map(({ index }) => index)
                    .sort((a, b) => b - a);
                for (const index of indices) await layer.remove(base, index);
            }
        }
        await store.removePrompt(identifier);
        return 'removed';
    }

    /** True when the store can take a block out of the order (P-026). */
    canDetach(): boolean {
        return typeof this.deps.services.store()?.detachPrompt === 'function';
    }

    /** P-026: out of the order (in layer mode recorded as «off»: the layer has no detach operation). */
    async detach(identifier: string): Promise<void> {
        const store = this.store();
        if (typeof store.detachPrompt !== 'function') throw new Error('detach is not supported by the preset store');
        const layer = this.layerFor(identifier);
        if (layer) await this.record(layer, { op: 'toggle', identifier, enabled: false }, this.scopeFor(identifier));
        await store.detachPrompt(identifier);
    }

    /** P-028: back into the order at the start, switched off (the store inserts a block it enables or disables). */
    async insert(identifier: string): Promise<void> {
        const layer = this.layerFor(identifier);
        if (layer) {
            const scope = this.scopeFor(identifier);
            await this.record(layer, { op: 'move', identifier, anchor: { kind: 'start' } }, scope);
            await this.record(layer, { op: 'toggle', identifier, enabled: false }, scope);
        }
        await this.store().setEnabled([identifier], false);
    }

    async setKeys(patch: Record<string, unknown>): Promise<void> {
        const layer = this.layer();
        if (layer)
            for (const [key, value] of Object.entries(patch)) await this.record(layer, { op: 'key', key, value });
        await this.store().setKeys(patch);
    }
}

/** The block a layer operation is about (null for body keys). */
export function opTarget(op: LayerOp): string | null {
    if (op.op === 'add') return op.prompt.identifier;
    if (op.op === 'key') return null;
    return op.identifier;
}

/* ------------------------------------------------------------------ the window */

export interface StudioDeps {
    app: App;
    log: Logger;
    services: PresetServices;
    settings: PresetStudioSettings;
    saveSettings(): void;
    pm: PmInfo;
    /** Shows ST's Prompt Manager for the session (launcher) and brings the drawer forward. */
    showClassic(): void;
}

interface PopupHandle {
    show(): Promise<unknown>;
    completeCancelled(): Promise<unknown>;
    dlg: HTMLDialogElement;
}

const REFRESH_DELAY_MS = 40;

const SOURCE_KEYS: Record<string, string> = {
    charDescription: 'm34.source.charDescription',
    charPersonality: 'm34.source.charPersonality',
    scenario: 'm34.source.scenario',
    personaDescription: 'm34.source.personaDescription',
    worldInfoBefore: 'm34.source.worldInfoBefore',
    worldInfoAfter: 'm34.source.worldInfoAfter',
};

export class PresetStudio {
    private readonly app: App;
    private readonly dialogs: Dialogs;
    readonly router: EditRouter;
    private readonly started = new Set<string>();
    private popup: PopupHandle | null = null;
    private closing: { allowed: boolean } | null = null;
    private root: HTMLElement | null = null;
    private header: HTMLElement | null = null;
    private pane: HTMLElement | null = null;
    private side: HTMLElement | null = null;
    private layout: HTMLElement | null = null;
    private nav: TabsHandle | null = null;
    private tab: StudioTab;
    private offs: Unsubscribe[] = [];
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly blocksState = emptyBlocksState();
    /** «Условия»: flags ticked in the simulator and rows with the preview open (kept across presets). */
    private readonly condState = { on: new Set<string>(), expanded: new Set<string>() };
    private editor: EditorHandle | null = null;
    /** The block as it was when the editor opened (P-018: compared before writing). */
    private editorBase: PresetPrompt | null = null;
    private editorNew = false;
    /** Loaded per preset; null = stale. */
    private mapSlots: MapSlot[] | null = null;
    private mapError: string | null = null;
    /** Generation type of the map and the findings (triggers depend on it). */
    private mapType = 'normal';
    private findings: PresetFinding[] | null = null;
    private hints: ProviderHint[] = [];
    private analysisError: string | null = null;
    private versions: PresetVersion[] | null = null;
    private versionsError: string | null = null;
    private selectedVersion: string | null = null;
    private foreign: ForeignPick | null = null;
    private layerResult: { kind: 'migrate' | 'transfer'; report: LayerApplyReport } | null = null;
    private loadedFor: string | null = null;
    /** Where new edits go (plan-2 «Области действия»): «везде» by default, for this session only. */
    private editScope: LayerScope = 'global';
    /** «Промпты соседей»: the entry open for editing and the scope its copy goes to. */
    private readonly neighbourState: { open: string | null; scope: 'global' | 'character' | 'chat' } = {
        open: null,
        scope: 'global',
    };
    /** Loads in flight and invalidation counters: a load that an invalidation overtook is dropped. */
    private readonly loading = new Set<Loadable>();
    private readonly epoch: Record<Loadable, number> = { map: 0, analysis: 0, versions: 0 };

    constructor(private readonly deps: StudioDeps) {
        this.app = deps.app;
        this.dialogs = new Dialogs(deps.app);
        this.router = new EditRouter({
            services: deps.services,
            settings: deps.settings,
            started: this.started,
            newId: () => newIdentifier(deps.app),
            scope: () => this.editScope,
        });
        this.tab = STUDIO_TABS.includes(deps.settings.tab) ? deps.settings.tab : 'blocks';
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private store(): PresetStore | null {
        return this.deps.services.store();
    }

    isOpen(): boolean {
        return this.popup !== null;
    }

    currentTab(): StudioTab {
        return this.tab;
    }

    /* ---------------------------------------------------------------- open, close */

    /** Opens the window (on a block when given: identifier or name); a second call just switches to it. */
    open(identifier?: string): void {
        if (!this.app.host.isChatCompletion()) {
            this.app.ui.notice(this.t('m34.error.textCompletion'), { urgent: true, level: 'warn' });
            return;
        }
        const store = this.store();
        if (!store) {
            this.app.ui.notice(this.t('m34.error.noStore'), { urgent: true, level: 'error' });
            return;
        }
        if (!this.popup) {
            const ctx = this.app.host.ctx();
            if (typeof ctx.Popup !== 'function') {
                this.deps.log.error('ST Popup is not available; cannot open the Preset Studio');
                return;
            }
            this.root = this.buildChrome();
            const closing = { allowed: false };
            this.closing = closing;
            const popup = new ctx.Popup(this.root, ctx.POPUP_TYPE.DISPLAY, '', {
                wide: true,
                large: true,
                allowVerticalScrolling: false,
                animation: prefersReducedMotion() ? 'none' : 'fast',
                // Escape and ST's own close path: the block editor may keep the window open for unsaved edits.
                onClosing: () => (closing.allowed ? true : this.canLeave()),
            });
            popup.dlg.classList.add('maestro-m34-dialog');
            this.popup = popup;
            this.offs.push(store.onChange((reason) => this.onStoreChange(reason)));
            const layer = this.deps.services.layer();
            if (layer) this.offs.push(layer.onChange(() => this.scheduleRefresh()));
            const neighbours = this.deps.services.neighbours?.();
            if (neighbours) this.offs.push(neighbours.onChange(() => this.scheduleRefresh()));
            void popup.show().then(
                () => this.handleClosed(popup),
                () => this.handleClosed(popup),
            );
            void this.deps.pm.load().then(() => this.scheduleRefresh());
        }
        const target = identifier ? this.resolveBlock(identifier) : null;
        if (target) {
            this.selectTab('blocks');
            void this.openEditor(target);
            return;
        }
        void this.render();
    }

    /** An identifier or a block name (the slash command takes either). */
    private resolveBlock(value: string): string | null {
        const rows = this.store()?.prompts() ?? [];
        const exact = rows.find((row) => row.item.identifier === value);
        if (exact) return value;
        const lower = value.trim().toLowerCase();
        const byName = rows.find((row) => row.prompt && promptName(row.prompt).toLowerCase() === lower);
        return byName ? byName.item.identifier : null;
    }

    /** True when nothing stops leaving the open block editor (no editor, not dirty, or the user decided). */
    async canLeave(): Promise<boolean> {
        const editor = this.editor;
        if (!editor || !editor.dirty()) return true;
        const choice = await this.dialogs.choose(
            this.t('m34.leave.title'),
            this.t('m34.leave.body', { name: editor.read().name || editor.identifier }),
            [
                { value: 'save', label: this.t('m34.leave.save') },
                { value: 'discard', label: this.t('m34.leave.discard') },
            ],
        );
        if (choice === 'discard') return true;
        if (choice === 'save') return this.saveEditor(editor.read());
        return false;
    }

    async requestClose(): Promise<boolean> {
        if (!this.popup) return true;
        if (!(await this.canLeave())) return false;
        this.close();
        return true;
    }

    /** Closes without asking (module disable, or after the guard agreed). */
    close(): void {
        const popup = this.popup;
        if (!popup) return;
        if (this.closing) this.closing.allowed = true;
        this.handleClosed(popup);
        void popup.completeCancelled().catch((error: unknown) => this.deps.log.debug('preset studio close', error));
    }

    dispose(): void {
        this.close();
    }

    private handleClosed(popup: PopupHandle): void {
        if (this.popup !== popup) return;
        this.disposeEditor();
        for (const off of this.offs.splice(0)) off();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        this.popup = null;
        this.root = null;
        this.header = null;
        this.pane = null;
        this.side = null;
        this.layout = null;
        this.nav = null;
    }

    /* ---------------------------------------------------------------- chrome */

    private buildChrome(): HTMLElement {
        this.header = el('div', { class: 'maestro-m34-header' });
        this.nav = tabs({
            label: this.t('m34.nav.label'),
            active: this.tab,
            items: STUDIO_TABS.map((id) => ({ id, label: this.t(`m34.tab.${id}`), icon: TAB_ICONS[id] })),
            onSelect: (id) => this.selectTab(id as StudioTab),
        });
        this.pane = el('div', { class: 'maestro-m34-pane', attrs: { role: 'tabpanel' } });
        this.side = el('aside', { class: 'maestro-m34-side', attrs: { 'aria-label': this.t('m34.editor.panel') } });
        this.side.hidden = true;
        this.layout = el('div', { class: 'maestro-m34-layout' }, [this.pane, this.side]);
        return el('div', { class: 'maestro-m34 maestro-ui' }, [
            this.header,
            el('div', { class: 'maestro-m34-nav' }, [this.nav.list, this.nav.picker]),
            this.layout,
        ]);
    }

    selectTab(tab: StudioTab): void {
        if (!STUDIO_TABS.includes(tab)) return;
        this.tab = tab;
        this.nav?.setActive(tab);
        if (this.deps.settings.tab !== tab) {
            this.deps.settings.tab = tab;
            this.deps.saveSettings();
        }
        void this.render();
    }

    private renderHeader(): void {
        const header = this.header;
        const store = this.store();
        if (!header || !store) return;
        const current = store.current();
        const select = el('select', {
            class: 'text_pole maestro-m34-preset',
            attrs: { 'aria-label': this.t('m34.header.preset') },
        });
        const names = store.names();
        for (const name of names) select.append(el('option', { text: name, attrs: { value: name } }));
        if (!names.includes(current)) select.append(el('option', { text: current, attrs: { value: current } }));
        select.value = current;
        select.addEventListener('change', () => {
            const name = select.value;
            void this.switchPreset(name).then((ok) => {
                if (!ok && select.isConnected) select.value = this.store()?.current() ?? current;
            });
        });
        const draft = store.draft();
        const pmError = this.deps.pm.error();
        const layerMode = this.router.layerMode();
        const layer = this.deps.services.layer();
        const hasLayer = !!layer && layer.get(current) !== null;
        header.replaceChildren();
        append(header, [
            el('div', { class: 'maestro-m34-brand' }, [icon('fa-sliders'), el('h3', { text: this.t('m34.title') })]),
            select,
            draft.dirty
                ? el('span', {
                      class: 'maestro-m34-badge maestro-m34-badge-warn maestro-m34-unsaved',
                      text: this.t('m34.header.unsaved'),
                      title: this.t('m34.header.unsavedHint', {
                          prompts: draft.changedPrompts.length,
                          keys: draft.changedKeys.length,
                      }),
                  })
                : null,
            // P-010, P-119: the assembly error PM shows in its header.
            pmError
                ? el('span', {
                      class: 'maestro-m34-badge maestro-m34-badge-conflict maestro-m34-pm-error',
                      text: this.t('m34.header.pmError'),
                      title: pmError,
                      attrs: { role: 'status' },
                  })
                : null,
            el('span', {
                class: ['maestro-m34-badge', layerMode ? 'maestro-m34-badge-layer' : null, 'maestro-m34-mode'],
                text: layerMode ? this.t('m34.header.modeLayer') : this.t('m34.header.modeStore'),
                title: layerMode
                    ? this.t('m34.header.modeLayerHint', { base: current })
                    : this.t('m34.header.modeStoreHint'),
            }),
            layerMode && this.router.scope() !== 'global'
                ? el('span', {
                      class: 'maestro-m34-badge maestro-m34-badge-layer maestro-m34-scope-badge',
                      text: this.t('m34.scope.badge', {
                          scope: scopeLabel(this.app, this.router.scope(), layer?.context?.() ?? null),
                      }),
                      title: this.t('m34.scope.hint'),
                  })
                : null,
            this.bindingBadge(),
            el(
                'div',
                {
                    class: 'maestro-m34-actions',
                    attrs: { role: 'toolbar', 'aria-label': this.t('m34.header.actions') },
                },
                [
                    button({
                        icon: 'fa-floppy-disk',
                        label: layerMode ? this.t('m34.header.saveLayer') : this.t('m34.header.save'),
                        title: layerMode ? this.t('m34.header.saveLayerHint') : this.t('m34.header.saveHint'),
                        kind: 'primary',
                        className: 'maestro-m34-save',
                        onClick: async () => {
                            await this.save();
                        },
                    }),
                    hasLayer
                        ? button({
                              icon: 'fa-database',
                              label: this.t('m34.header.saveBase'),
                              title: this.t('m34.header.saveBaseHint'),
                              className: 'maestro-m34-save-base',
                              onClick: async () => {
                                  await this.saveBase();
                              },
                          })
                        : null,
                    button({
                        icon: 'fa-file-circle-plus',
                        title: this.t('m34.header.saveAs'),
                        className: 'maestro-m34-save-as',
                        onClick: () => this.saveAs(),
                    }),
                    typeof layer?.bind === 'function'
                        ? button({
                              icon: 'fa-link',
                              title: this.t('m34.binding.button'),
                              className: 'maestro-m34-bind',
                              onClick: () => this.bindDialog(),
                          })
                        : null,
                    button({
                        icon: 'fa-pen',
                        title: this.t('m34.header.rename'),
                        className: 'maestro-m34-rename',
                        onClick: () => this.rename(),
                    }),
                    button({
                        icon: 'fa-file-import',
                        title: this.t('m34.header.import'),
                        className: 'maestro-m34-import',
                        onClick: () => this.importPreset(),
                    }),
                    button({
                        icon: 'fa-file-export',
                        title: this.t('m34.header.export'),
                        className: 'maestro-m34-export',
                        onClick: () => this.exportPreset(),
                    }),
                    button({
                        icon: 'fa-trash-can',
                        kind: 'danger',
                        title: this.t('m34.header.delete'),
                        className: 'maestro-m34-delete-preset',
                        onClick: () => this.deletePreset(),
                    }),
                    this.assistant()
                        ? button({
                              icon: 'fa-comments',
                              title: this.t('m34.discuss.preset'),
                              className: 'maestro-m34-discuss',
                              onClick: () => this.discuss(),
                          })
                        : null,
                    button({
                        icon: 'fa-list-ul',
                        label: this.t('m34.classic'),
                        title: this.t('m34.classicHint'),
                        className: 'maestro-m34-classic',
                        onClick: () => this.openClassic(),
                    }),
                    button({
                        icon: 'fa-xmark',
                        kind: 'ghost',
                        title: this.t('m34.close'),
                        className: 'maestro-m34-close',
                        onClick: async () => {
                            await this.requestClose();
                        },
                    }),
                ],
            ),
        ]);
    }

    /* ---------------------------------------------------------------- refresh */

    private invalidate(...what: Loadable[]): void {
        for (const item of what) {
            this.epoch[item]++;
            if (item === 'map') this.mapSlots = null;
            else if (item === 'analysis') this.findings = null;
            else this.versions = null;
        }
    }

    private onStoreChange(reason: 'prompts' | 'keys' | 'preset' | 'list'): void {
        if (reason === 'preset') {
            this.loadedFor = null;
            this.selectedVersion = null;
            this.blocksState.selected.clear();
            this.invalidate('versions');
            const editor = this.editor;
            if (editor && !this.editorNew) {
                if (editor.dirty()) editor.markStale();
                else this.closeEditor();
            }
        }
        if (reason === 'prompts' || reason === 'preset') {
            this.invalidate('map', 'analysis');
            this.blocksState.substituted.clear();
        }
        if (reason === 'keys') this.invalidate('analysis');
        this.scheduleRefresh();
    }

    scheduleRefresh(): void {
        if (this.refreshTimer || !this.popup) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            if (this.popup) void this.render();
        }, REFRESH_DELAY_MS);
    }

    /** Re-renders the header and the current tab (the map, findings and versions load in the background). */
    async render(): Promise<void> {
        const pane = this.pane;
        const store = this.store();
        if (!pane || !store) return;
        const current = store.current();
        if (this.loadedFor !== current) {
            this.loadedFor = current;
            this.invalidate('map', 'analysis', 'versions');
        }
        // A value being typed into «Параметры» must not be wiped by a refresh: wait for its commit.
        if (this.tab === 'params' && pane.querySelector('.maestro-m34-typing')) {
            this.renderHeader();
            pane.addEventListener('focusout', () => this.scheduleRefresh(), { once: true });
            return;
        }
        this.renderHeader();
        this.layout?.classList.toggle('maestro-m34-with-editor', this.editor !== null);
        // Token counts of the block list come from the map too.
        const loads: Promise<void>[] = [];
        if (this.mapSlots === null) loads.push(this.loadMap());
        if (this.tab === 'analysis' && this.findings === null) loads.push(this.loadAnalysis());
        if (this.tab === 'versions' && this.versions === null) loads.push(this.loadVersions());
        this.renderTab();
        await Promise.all(loads);
    }

    private renderTab(): void {
        const pane = this.pane;
        const store = this.store();
        if (!pane || !store) return;
        keepFocus(pane, () => {
            switch (this.tab) {
                case 'map':
                    pane.replaceChildren(this.mapPanel());
                    return;
                case 'analysis':
                    pane.replaceChildren(this.analysisPanel());
                    return;
                case 'conditional':
                    pane.replaceChildren(this.conditionalPanel());
                    return;
                case 'versions':
                    pane.replaceChildren(this.versionsPanel());
                    return;
                case 'layer':
                    pane.replaceChildren(renderLayerPanel(this.app, this.layerModel(), this.layerActions()));
                    return;
                case 'neighbours':
                    pane.replaceChildren(
                        renderNeighboursPanel(this.app, {
                            api: this.deps.services.neighbours?.() ?? null,
                            state: this.neighbourState,
                            run: (action) => this.run(action),
                            confirm: (title, body) => this.dialogs.confirm(title, body),
                            rerender: () => this.renderTab(),
                        }),
                    );
                    return;
                case 'params':
                    pane.replaceChildren(
                        renderParamsPanel(
                            this.app,
                            { body: store.working(), layerMode: this.router.layerMode() },
                            {
                                set: async (key, value) => {
                                    await this.run(() => this.router.setKeys({ [key]: value }));
                                },
                            },
                        ),
                        renderScenariosPanel(this.app, this.scenariosModel(), {
                            set: (id, values) => this.setScenario(id, values),
                            reset: (id) => this.setScenario(id, null),
                        }),
                    );
                    return;
                default:
                    pane.replaceChildren(
                        renderBlocksPanel(this.app, this.blocksModel(), this.blocksState, this.blockActions()),
                    );
            }
        });
    }

    private scenariosModel(): ScenariosModel {
        const api = this.deps.services.scenarios();
        if (
            !api ||
            typeof api.list !== 'function' ||
            typeof api.params !== 'function' ||
            typeof api.setParams !== 'function'
        )
            return { available: false, items: [] };
        const items: ScenariosModel['items'] = [];
        for (const descriptor of api.list()) {
            const values = api.params(descriptor.id);
            if (values) items.push({ descriptor, values });
        }
        return { available: true, items };
    }

    /** Stores a scenario's parameters (null: back to its defaults). */
    private setScenario(id: string, values: Parameters<NonNullable<ScenariosApi['setParams']>>[1]): void {
        try {
            this.deps.services.scenarios()?.setParams?.(id, values);
        } catch (error) {
            this.deps.log.warn('scenario parameters were not stored', error);
            this.app.ui.notice(this.dialogs.errorText(error), { urgent: true, level: 'error' });
        }
        this.scheduleRefresh();
    }

    private names(): Map<string, string> {
        const prompts = this.store()?.working().prompts ?? [];
        return new Map(prompts.map((prompt) => [prompt.identifier, promptName(prompt)]));
    }

    /** Token counts: the analysis map when loaded (ST's tokenizer), else PM's last assembly. */
    private tokens(): Map<string, number> {
        if (this.mapSlots) return new Map(this.mapSlots.map((slot) => [slot.identifier, slot.tokens]));
        return this.deps.pm.counts();
    }

    /** Runs one load at a time per kind; a result an invalidation overtook is dropped and loaded again. */
    private async load(kind: Loadable, fetch: () => Promise<void>): Promise<void> {
        if (this.loading.has(kind)) return;
        this.loading.add(kind);
        const epoch = this.epoch[kind];
        try {
            await fetch();
        } finally {
            this.loading.delete(kind);
        }
        if (epoch !== this.epoch[kind]) {
            this.invalidate(kind);
            this.scheduleRefresh();
            return;
        }
        if (!this.popup) return;
        if (kind === this.tab || (kind === 'map' && this.tab === 'blocks')) this.renderTab();
    }

    /* ---------------------------------------------------------------- map and analysis */

    private reducedMap(): MapSlot[] {
        const counts = this.deps.pm.counts();
        return (this.store()?.prompts() ?? [])
            .filter((row) => row.prompt !== null)
            .map(({ item, prompt }) => {
                const block = prompt as PresetPrompt;
                const inChat = block.injection_position === 1;
                return {
                    identifier: item.identifier,
                    name: promptName(block),
                    role: promptRole(block),
                    placement: inChat ? ('depth' as const) : ('relative' as const),
                    depth: inChat ? promptDepth(block) : undefined,
                    order: inChat ? promptOrder(block) : undefined,
                    tokens: counts.get(item.identifier) ?? 0,
                    enabled: item.enabled,
                    marker: block.marker === true,
                    injections: [],
                };
            });
    }

    private loadMap(): Promise<void> {
        return this.load('map', async () => {
            const analysis = this.deps.services.analysis();
            if (!analysis) {
                this.mapSlots = this.reducedMap();
                return;
            }
            try {
                this.mapSlots = await analysis.map(undefined, { type: this.mapType });
                this.mapError = null;
            } catch (error) {
                this.deps.log.warn('preset map failed', error);
                this.mapError = error instanceof Error ? error.message : String(error);
                this.mapSlots = this.reducedMap();
            }
        });
    }

    private mapPanel(): HTMLElement {
        return renderMapPanel(
            this.app,
            { slots: this.mapSlots, reduced: !this.deps.services.analysis(), error: this.mapError, type: this.mapType },
            {
                open: (identifier) => void this.openEditor(identifier),
                refresh: async () => {
                    this.invalidate('map');
                    await this.render();
                },
                setType: (type) => {
                    this.mapType = type;
                    this.invalidate('map', 'analysis');
                    this.rerender();
                },
            },
        );
    }

    private loadAnalysis(): Promise<void> {
        return this.load('analysis', async () => {
            const analysis = this.deps.services.analysis();
            if (!analysis) {
                this.findings = [];
                return;
            }
            try {
                this.findings = await analysis.findings(undefined, { type: this.mapType });
                this.hints = analysis.hints();
                this.analysisError = null;
            } catch (error) {
                this.deps.log.warn('preset analysis failed', error);
                this.analysisError = error instanceof Error ? error.message : String(error);
                this.findings = [];
            }
        });
    }

    private analysisPanel(): HTMLElement {
        const analysis = this.deps.services.analysis();
        return renderAnalysisPanel(
            this.app,
            {
                findings: analysis ? this.findings : [],
                hints: this.hints,
                unavailable: !analysis,
                error: this.analysisError,
                names: this.names(),
                extra: conditionalFindings(this.app, this.condRows()),
            },
            {
                open: (identifier) => void this.openEditor(identifier),
                refresh: async () => {
                    this.invalidate('analysis');
                    await this.render();
                },
            },
        );
    }

    /* ---------------------------------------------------------------- conditional blocks */

    /**
     * The flags the studio offers: the director's catalogue, the fallbacks, the preset's own. The editor offers only
     * Maestro's (`forEditor`): a variable of the user's own is never set or cleared by Maestro.
     */
    flagOptions(forEditor = false): FlagOption[] {
        const entries = flagCatalogue(this.app, this.store()?.working()).filter(
            (entry) => !forEditor || entry.source !== 'preset' || isMaestroFlag(entry.name),
        );
        return entries.map((entry) => ({
            name: entry.name,
            label: flagLabel(this.app, entry),
            hint: flagHint(this.app, entry),
            source: entry.source,
        }));
    }

    private condRows(): ConditionalRow[] {
        const store = this.store();
        if (!store) return [];
        return conditionalRows(store, knownFlags(this.app), macroEngineState(this.app));
    }

    private conditionalPanel(): HTMLElement {
        const state = this.condState;
        const current = directorCurrentFlags(this.app);
        return renderConditionalPanel(
            this.app,
            {
                engine: macroEngineState(this.app),
                flags: this.flagOptions(),
                on: state.on,
                rows: this.condRows(),
                current,
                expanded: state.expanded,
            },
            {
                setFlag: (name, on) => {
                    if (on) state.on.add(name);
                    else state.on.delete(name);
                    this.renderTab();
                },
                reset: () => {
                    state.on.clear();
                    this.renderTab();
                },
                useCurrent: () => {
                    state.on.clear();
                    for (const name of directorFlagsOn(this.app)) state.on.add(name);
                    for (const name of mechanicsFlagsOn(this.app)) state.on.add(name);
                    this.renderTab();
                },
                open: (identifier) => void this.openEditor(identifier),
                expand: (identifier, open) => {
                    if (open) state.expanded.add(identifier);
                    else state.expanded.delete(identifier);
                },
            },
        );
    }

    /* ---------------------------------------------------------------- versions */

    private loadVersions(): Promise<void> {
        return this.load('versions', async () => {
            const store = this.store();
            if (!store) return;
            try {
                this.versions = await store.versions(store.current());
                this.versionsError = null;
            } catch (error) {
                this.deps.log.warn('preset versions failed', error);
                this.versionsError = error instanceof Error ? error.message : String(error);
                this.versions = [];
            }
        });
    }

    private versionsPanel(): HTMLElement {
        const store = this.store() as PresetStore;
        return renderVersionsPanel(
            this.app,
            {
                name: store.current(),
                versions: this.versions,
                selected: this.selectedVersion,
                working: store.working(),
                error: this.versionsError,
            },
            this.names(),
            {
                select: (id) => {
                    this.selectedVersion = id;
                    this.renderTab();
                },
                restore: (id) => this.restoreVersion(id),
                refresh: async () => {
                    this.invalidate('versions');
                    await this.render();
                },
            },
        );
    }

    async restoreVersion(id: string): Promise<void> {
        const store = this.store();
        if (!store) return;
        const name = store.current();
        const version = this.versions?.find((item) => item.id === id);
        const when = version ? new Date(version.at).toLocaleString() : id;
        const ok = await this.dialogs.confirm(
            this.t('m34.versions.restoreTitle'),
            this.t('m34.versions.restoreBody', { name, when }),
            this.t('m34.versions.restore'),
        );
        if (!ok) return;
        const done = await this.run(async () => {
            await store.restoreVersion(name, id);
            return true;
        });
        if (!done) return;
        this.app.ui.notice(this.t('m34.versions.restored', { name }), { urgent: true });
        this.selectedVersion = null;
        this.invalidate('versions');
        await this.render();
    }

    /* ---------------------------------------------------------------- blocks */

    private layerIds(): { touched: Set<string>; conflicts: Set<string> } {
        const layer = this.deps.services.layer();
        const store = this.store();
        const touched = new Set<string>();
        const conflicts = new Set<string>();
        if (!layer || !store) return { touched, conflicts };
        for (const op of layer.get(store.current())?.ops ?? []) {
            if (op.op === 'add') touched.add(op.prompt.identifier);
            else if (op.op !== 'key') touched.add(op.identifier);
        }
        for (const conflict of layer.lastReport()?.conflicts ?? []) conflicts.add(conflict.identifier);
        return { touched, conflicts };
    }

    private blocksModel(): BlocksModel {
        const store = this.store() as PresetStore;
        const rows = store
            .prompts()
            .map(({ item, prompt }) => ({ identifier: item.identifier, enabled: item.enabled, prompt }));
        const ids = this.layerIds();
        return {
            rows,
            detached: detachedPrompts(
                store.working().prompts ?? [],
                rows.map((row) => row.identifier),
            ),
            tokens: this.tokens(),
            layerIds: ids.touched,
            conflicts: ids.conflicts,
            overridden: this.deps.pm.overridden(),
            openId: this.editor && !this.editorNew ? this.editor.identifier : null,
            layerMode: this.router.layerMode(),
            canDetach: this.router.canDetach(),
            draggable: !coarsePointer(),
        };
    }

    private orderIds(): string[] {
        return (this.store()?.prompts() ?? []).map((row) => row.item.identifier);
    }

    private promptOf(identifier: string): PresetPrompt | null {
        return (this.store()?.working().prompts ?? []).find((prompt) => prompt.identifier === identifier) ?? null;
    }

    private async run<T>(action: () => Promise<T>): Promise<T | undefined> {
        return this.dialogs.run(action);
    }

    private rerender(): void {
        void this.render();
    }

    blockActions(): BlocksActions {
        const state = this.blocksState;
        return {
            open: (identifier) => void this.openEditor(identifier),
            toggle: async (identifiers, enabled) => {
                await this.run(() => this.router.toggle(identifiers, enabled));
                this.rerender();
            },
            move: async (identifier, toIndex) => {
                const before = this.orderIds();
                const from = before.indexOf(identifier);
                if (from < 0) return;
                const after = moveItem(before, from, toIndex);
                state.focusId = identifier;
                await this.run(() => this.router.reorder(before, after, [identifier]));
                this.rerender();
            },
            add: () => this.newBlock(),
            duplicate: async (identifier) => {
                const prompt = this.promptOf(identifier);
                if (!prompt) return;
                const taken = (this.store()?.working().prompts ?? []).map((item) => promptName(item));
                const copy: PresetPrompt = {
                    ...structuredClone(prompt),
                    identifier: newIdentifier(this.app),
                    name: copyName(promptName(prompt), taken, this.t('m34.blocks.copySuffix')),
                    ...userFlagsPatch({ identifier: '' }),
                };
                const id = await this.run(() => this.router.add(copy, identifier, false));
                if (id) state.focusId = id;
                this.rerender();
            },
            remove: async (identifier) => {
                const prompt = this.promptOf(identifier);
                const name = prompt ? promptName(prompt) : identifier;
                const layerMode = this.router.layerMode();
                const body = layerMode
                    ? this.t('m34.blocks.deleteLayerBody', { name })
                    : this.t('m34.blocks.deleteBody', { name });
                if (!(await this.dialogs.confirm(this.t('m34.blocks.deleteTitle'), body, this.t('m34.dialog.delete'))))
                    return;
                const result = await this.run(() => this.router.remove(identifier));
                if (result === 'disabled')
                    this.app.ui.notice(this.t('m34.blocks.disabledInLayer', { name }), { urgent: true });
                state.selected.delete(identifier);
                if (this.editor?.identifier === identifier) this.closeEditor();
                this.rerender();
            },
            detach: async (identifier) => {
                await this.run(() => this.router.detach(identifier));
                state.selected.delete(identifier);
                this.rerender();
            },
            insert: async (identifier) => {
                await this.run(() => this.router.insert(identifier));
                state.insertChoice = '';
                state.focusId = identifier;
                this.rerender();
            },
            importList: () => this.importPromptList(),
            exportList: () => this.exportPromptList(),
            resetOrder: () => this.resetOrder(),
            substitute: (identifier) => this.substitute(identifier),
            changed: () => this.rerender(),
            discuss: this.assistant() ? (identifier) => this.discuss(identifier) : undefined,
        };
    }

    /** The assistant when it can take a preset or a block into a conversation (its module on). */
    private assistant(): AssistantApi | null {
        const api = this.app.modules.api<AssistantApi>('assistant');
        return api && typeof api.discuss === 'function' ? api : null;
    }

    /**
     * «Обсудить с ассистентом» (plan-2 §1 п. 7): the assistant opens with the preset, or one of its blocks, attached to
     * the next message; what it applies reaches the studio through the store's and the layer's change events.
     */
    discuss(identifier?: string): void {
        const api = this.assistant();
        const preset = this.store()?.current();
        if (!api || !preset) return;
        if (identifier) {
            const prompt = this.promptOf(identifier);
            api.discuss?.({
                kind: 'presetBlock',
                preset,
                identifier,
                label: prompt ? promptName(prompt) : identifier,
            });
            return;
        }
        api.discuss?.({ kind: 'preset', preset, label: preset });
    }

    private async newBlock(): Promise<void> {
        if (!(await this.canLeave())) return;
        const draft: PresetPrompt = {
            identifier: newIdentifier(this.app),
            name: '',
            role: 'system',
            content: '',
            system_prompt: false,
            marker: false,
        };
        this.showEditor(draft, true);
    }

    /** Preview with ST's substituteParams (P-145: macros with side effects run too — asked first). */
    async substitute(identifier: string): Promise<void> {
        const prompt = this.promptOf(identifier);
        if (!prompt) return;
        const text = promptText(prompt);
        const effects = sideEffectMacros(text);
        if (
            effects.length &&
            !(await this.dialogs.confirm(
                this.t('m34.blocks.effectsTitle'),
                this.t('m34.blocks.effectsBody', { macros: effects.join(', ') }),
            ))
        )
            return;
        const ctx = this.app.host.ctx();
        let result: string;
        try {
            result = typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text;
        } catch (error) {
            this.deps.log.warn('macro preview failed', error);
            this.app.ui.notice(this.dialogs.errorText(error), { urgent: true, level: 'error' });
            return;
        }
        this.blocksState.substituted.set(identifier, result);
        this.blocksState.expanded.add(identifier);
        this.rerender();
    }

    private async importPromptList(): Promise<void> {
        const store = this.store();
        if (!store) return;
        if (!(await this.dialogs.confirm(this.t('m34.list.importTitle'), this.t('m34.list.importBody')))) return;
        const file = await this.dialogs.pickFile('.json');
        if (!file) return;
        const parsed = parsePromptList(await file.text());
        if (!parsed.ok) {
            this.app.ui.notice(this.t(`m34.list.invalid.${parsed.reason}`, { file: file.name }), {
                urgent: true,
                level: 'warn',
            });
            return;
        }
        const rows = store.prompts();
        const plan = planPromptListImport(
            store.working().prompts ?? [],
            rows.map((row) => row.item),
            parsed.file,
        );
        const done = await this.run(async () => {
            for (const update of plan.update) await this.router.editPrompt(update.identifier, update.patch);
            for (const prompt of plan.add) {
                await this.router.add(prompt as PresetPrompt, anchorFor(this.orderIds(), null) ?? null, false);
            }
            if (plan.order) await this.applyOrder(plan.order);
            return true;
        });
        if (done)
            this.app.ui.notice(this.t('m34.list.imported', { updated: plan.update.length, added: plan.add.length }), {
                urgent: true,
            });
        this.rerender();
    }

    private exportPromptList(): void {
        const store = this.store();
        if (!store) return;
        const file = buildPromptListExport(
            store.working().prompts ?? [],
            store.prompts().map((row) => row.item),
        );
        downloadJson(promptListFileName(new Date()), file);
    }

    /**
     * Brings the active order to `wanted` (prompt-list import, «reset order»): blocks missing from the order are
     * inserted with their state (the store inserts on enable/disable), the listed ones move first in that order
     * (the store keeps unlisted entries after them, like PM's index-wise Object.assign), then on/off follow.
     */
    private async applyOrder(wanted: readonly { identifier: string; enabled: boolean }[]): Promise<void> {
        const known = new Set((this.store()?.working().prompts ?? []).map((prompt) => prompt.identifier));
        const list = wanted.filter((entry) => known.has(entry.identifier));
        const listed = new Set(this.orderIds());
        for (const entry of list.filter((item) => !listed.has(item.identifier))) {
            await this.router.toggle([entry.identifier], entry.enabled);
        }
        const before = this.orderIds();
        const ids = list.map((entry) => entry.identifier);
        await this.router.reorder(before, [...ids, ...before.filter((identifier) => !ids.includes(identifier))]);
        const state = new Map(
            this.store()
                ?.prompts()
                .map((row) => [row.item.identifier, row.item.enabled]) ?? [],
        );
        const on = list.filter((entry) => entry.enabled && state.get(entry.identifier) === false);
        const off = list.filter((entry) => !entry.enabled && state.get(entry.identifier) === true);
        await this.router.toggle(
            on.map((entry) => entry.identifier),
            true,
        );
        await this.router.toggle(
            off.map((entry) => entry.identifier),
            false,
        );
    }

    /** P-033: ST's default global order; the user's blocks leave the list (when the store can detach) but stay. */
    private async resetOrder(): Promise<void> {
        const detach = this.router.canDetach();
        const body = this.t(detach ? 'm34.blocks.resetBody' : 'm34.blocks.resetBodyKeep');
        if (!(await this.dialogs.confirm(this.t('m34.blocks.resetTitle'), body))) return;
        await this.run(async () => {
            await this.applyOrder(DEFAULT_PROMPT_ORDER);
            if (!detach) return;
            const defaults = new Set(DEFAULT_PROMPT_ORDER.map((entry) => entry.identifier));
            for (const identifier of this.orderIds().filter((item) => !defaults.has(item))) {
                await this.router.detach(identifier);
            }
        });
        this.rerender();
    }

    /* ---------------------------------------------------------------- block editor */

    /** Opens a block in the side panel; false when the open editor asked to stay. */
    async openEditor(identifier: string): Promise<boolean> {
        if (this.editor?.identifier === identifier && !this.editorNew) {
            this.editor.focus();
            return true;
        }
        if (!(await this.canLeave())) return false;
        const prompt = this.promptOf(identifier);
        if (!prompt) {
            this.app.ui.notice(this.t('m34.editor.missing'), { urgent: true, level: 'warn' });
            return false;
        }
        this.showEditor(prompt, false);
        return true;
    }

    private showEditor(prompt: PresetPrompt, isNew: boolean): void {
        const side = this.side;
        if (!side) return;
        this.disposeEditor();
        this.editorBase = structuredClone(prompt);
        this.editorNew = isNew;
        const handle = renderBlockEditor(
            this.app,
            {
                prompt,
                isNew,
                layerMode: this.router.layerMode(),
                sourceKey: (EXTERNAL_MARKERS as readonly string[]).includes(prompt.identifier)
                    ? (SOURCE_KEYS[prompt.identifier] ?? null)
                    : null,
                conditions: { flags: this.flagOptions(true), engine: macroEngineState(this.app) },
                scope: this.scopeModel(),
            },
            {
                save: (fields) => this.saveEditor(fields),
                close: () => void this.closeEditorAsked(),
                countTokens: async (text) => {
                    try {
                        return await this.app.host.ctx().getTokenCountAsync(text);
                    } catch {
                        return null;
                    }
                },
            },
        );
        this.editor = handle;
        side.replaceChildren(handle.element);
        side.hidden = false;
        this.layout?.classList.add('maestro-m34-with-editor');
        for (const row of this.pane?.querySelectorAll<HTMLElement>('.maestro-m34-block') ?? []) {
            row.classList.toggle('maestro-on', !isNew && row.dataset.id === prompt.identifier);
        }
        handle.focus();
    }

    private disposeEditor(): void {
        this.editor?.dispose();
        this.editor = null;
        this.editorBase = null;
        this.editorNew = false;
    }

    closeEditor(): void {
        this.disposeEditor();
        if (this.side) {
            this.side.replaceChildren();
            this.side.hidden = true;
        }
        this.layout?.classList.remove('maestro-m34-with-editor');
        for (const row of this.pane?.querySelectorAll<HTMLElement>('.maestro-m34-block.maestro-on') ?? [])
            row.classList.remove('maestro-on');
    }

    /** The editor's ×: asks about unsaved edits first. */
    async closeEditorAsked(): Promise<boolean> {
        if (!(await this.canLeave())) return false;
        this.closeEditor();
        return true;
    }

    editorOpen(): string | null {
        return this.editor ? this.editor.identifier : null;
    }

    /** Writes the form (new block: added at the start; existing: only the fields the user changed). */
    async saveEditor(fields: BlockFields): Promise<boolean> {
        const base = this.editorBase;
        const store = this.store();
        if (!base || !store) return false;
        if (this.editorNew) {
            const draft: PresetPrompt = { ...base, identifier: base.identifier };
            const patch = fieldsPatch(draft, fields);
            const prompt = { ...draft, ...patch } as PresetPrompt;
            if (!promptName(prompt).trim() || prompt.name === prompt.identifier)
                prompt.name = this.t('m34.blocks.newName');
            const id = await this.run(() => this.router.add(prompt, null, true));
            if (!id) return false;
            this.closeEditor();
            this.blocksState.focusId = id;
            this.app.ui.notice(this.t('m34.editor.added', { name: promptName(prompt) }), { urgent: true });
            this.rerender();
            return true;
        }
        const current = this.promptOf(base.identifier);
        if (!current) {
            this.app.ui.notice(this.t('m34.editor.missing'), { urgent: true, level: 'warn' });
            return false;
        }
        // P-018: somebody (classic PM, /setpromptentry, a neighbour) changed the block meanwhile.
        if (JSON.stringify(current) !== JSON.stringify(base)) {
            const ok = await this.dialogs.confirm(
                this.t('m34.editor.changedTitle'),
                this.t('m34.editor.changedBody', { name: promptName(current) }),
                this.t('m34.editor.overwrite'),
            );
            if (!ok) return false;
        }
        const patch = fieldsPatch(base, fields);
        const done = await this.run(async () => {
            await this.router.editPrompt(base.identifier, patch as Partial<PresetPrompt>);
            return true;
        });
        if (!done) return false;
        this.closeEditor();
        this.blocksState.focusId = base.identifier;
        this.rerender();
        return true;
    }

    /* ---------------------------------------------------------------- presets */

    /**
     * Switches the preset; with unsaved edits asks «Сохранить / Отбросить / Отмена» first (P-073). `reason` (a bound
     * chat selecting its preset) is said first in that question.
     */
    async switchPreset(name: string, options: { reason?: string } = {}): Promise<boolean> {
        const store = this.store();
        if (!store || name === store.current()) return false;
        if (!(await this.canLeave())) return false;
        if (store.draft().dirty) {
            const layerMode = this.router.layerMode();
            const actions: { value: 'layer' | 'base' | 'discard'; label: string }[] = layerMode
                ? [
                      { value: 'layer', label: this.t('m34.switch.saveLayer') },
                      { value: 'base', label: this.t('m34.switch.saveBase') },
                      { value: 'discard', label: this.t('m34.switch.discard') },
                  ]
                : [
                      { value: 'base', label: this.t('m34.switch.save') },
                      { value: 'discard', label: this.t('m34.switch.discard') },
                  ];
            const question = this.t(layerMode ? 'm34.switch.bodyLayer' : 'm34.switch.body', {
                from: store.current(),
                to: name,
            });
            const choice = await this.dialogs.choose(
                this.t('m34.switch.title'),
                options.reason ? `${options.reason} ${question}` : question,
                actions,
            );
            if (!choice) return false;
            if (choice !== 'discard' && !(await this.saveTo(choice))) return false;
        }
        const done = await this.run(async () => {
            await store.select(name);
            return true;
        });
        this.closeEditor();
        await this.render();
        return done === true;
    }

    /**
     * «Сохранить». Without a layer: the working copy into the preset file. In layer mode the studio's edits are in
     * the layer already; what else the working copy holds (classic editor, commands) goes into the layer or the base,
     * as the user chooses.
     */
    async save(): Promise<boolean> {
        const store = this.store();
        if (!store) return false;
        if (!this.router.layerMode()) return this.saveTo('base');
        const base = store.current();
        if (!store.draft().dirty) {
            this.app.ui.notice(this.t('m34.save.inLayer', { base }), { urgent: true });
            return true;
        }
        const choice = await this.dialogs.choose(
            this.t('m34.save.layerTitle'),
            this.t('m34.save.layerBody', { base }),
            [
                { value: 'layer' as const, label: this.t('m34.switch.saveLayer') },
                { value: 'base' as const, label: this.t('m34.switch.saveBase') },
            ],
        );
        return choice ? this.saveTo(choice) : false;
    }

    /**
     * 'base': an explicit-body save of the working copy into the current preset (store.save strips the user's layer
     * from the current preset itself, store.ts saveWorking). 'layer': the differences between the saved base and the
     * working copy become layer operations (layer.migrateFrom merges them by block and key).
     */
    async saveTo(target: 'layer' | 'base'): Promise<boolean> {
        const store = this.store();
        if (!store) return false;
        const base = store.current();
        const layer = this.deps.services.layer();
        if (target === 'layer' && layer) {
            // Into the scope new edits go to: compared with the base below it, without the scopes above it.
            const scope = this.router.scope();
            const reference =
                (scope === 'global' ? null : layer.below?.(base, scope)) ??
                store.saved(base) ??
                layer.strip(base, store.working());
            const edited = layer.strip(base, store.working(), scopesAbove(scope));
            const report = await this.migrateInto(
                base,
                reference,
                edited,
                this.t('m34.save.layerIntro', { base }),
                scope,
            );
            if (!report) return false;
            const conflicts = report.conflicts.length;
            this.app.ui.notice(
                this.t(conflicts ? 'm34.save.toLayerConflicts' : 'm34.save.toLayer', {
                    base,
                    applied: report.applied,
                    conflicts,
                }),
                { urgent: true, level: conflicts ? 'warn' : 'info' },
            );
            this.rerender();
            return true;
        }
        const done = await this.run(async () => {
            await store.save(base, this.t('m34.save.summary'));
            return true;
        });
        if (!done) return false;
        this.app.ui.notice(this.t('m34.save.done', { name: base }), { urgent: true });
        this.invalidate('versions');
        this.rerender();
        return true;
    }

    /** «Сохранить базу»: the working copy without the user's layer into the base file. */
    async saveBase(): Promise<boolean> {
        const store = this.store();
        if (!store) return false;
        const base = store.current();
        const ok = await this.dialogs.confirm(
            this.t('m34.saveBase.title'),
            this.t('m34.saveBase.body', { base }),
            this.t('m34.saveBase.ok'),
        );
        return ok ? this.saveTo('base') : false;
    }

    private async saveAs(): Promise<void> {
        const store = this.store();
        if (!store) return;
        const name = await this.dialogs.input(this.t('m34.saveAs.title'), store.current(), this.t('m34.saveAs.hint'));
        if (!name) return;
        const saved = await this.run(() => store.saveAs(name));
        if (saved) this.app.ui.notice(this.t('m34.saveAs.done', { name: saved }), { urgent: true });
        this.rerender();
    }

    private async rename(): Promise<void> {
        const store = this.store();
        if (!store) return;
        const current = store.current();
        const name = await this.dialogs.input(
            this.t('m34.rename.title', { name: current }),
            current,
            this.t('m34.rename.hint'),
        );
        if (!name || name === current) return;
        const done = await this.run(async () => {
            await store.rename(current, name);
            return true;
        });
        if (done) this.app.ui.notice(this.t('m34.rename.done', { from: current, to: name }), { urgent: true });
        this.rerender();
    }

    private async deletePreset(): Promise<void> {
        const store = this.store();
        if (!store) return;
        const current = store.current();
        if (
            !(await this.dialogs.confirm(
                this.t('m34.delete.title'),
                this.t('m34.delete.body', { name: current }),
                this.t('m34.dialog.delete'),
            ))
        )
            return;
        const done = await this.run(async () => {
            await store.remove(current);
            return true;
        });
        if (done) this.app.ui.notice(this.t('m34.delete.done', { name: current }), { urgent: true });
        this.closeEditor();
        this.rerender();
    }

    private async importPreset(): Promise<void> {
        const store = this.store();
        if (!store) return;
        if (
            store.draft().dirty &&
            !(await this.dialogs.confirm(this.t('m34.import.title'), this.t('m34.import.dirty')))
        )
            return;
        const file = await this.dialogs.pickFile('.json,.settings');
        if (!file) return;
        const name = await this.run(() => store.importFile(file));
        if (name) this.app.ui.notice(this.t('m34.import.done', { name }), { urgent: true });
        this.rerender();
    }

    private async exportPreset(): Promise<void> {
        const store = this.store();
        if (!store) return;
        const current = store.current();
        const choice = await this.dialogs.choose(
            this.t('m34.export.title', { name: current }),
            this.t('m34.export.body'),
            [
                { value: 'safe', label: this.t('m34.export.safe') },
                { value: 'connection', label: this.t('m34.export.connection') },
                { value: 'all', label: this.t('m34.export.all') },
            ],
        );
        if (!choice) return;
        // P-070, P-096: connection data and secrets are left out unless asked for.
        await this.run(() =>
            store.exportPreset(current, { withConnection: choice !== 'safe', withSensitive: choice === 'all' }),
        );
    }

    private async openClassic(): Promise<void> {
        if (!(await this.requestClose())) return;
        this.deps.showClassic();
    }

    /* ---------------------------------------------------------------- layer */

    private layerModel(): LayerModel {
        const store = this.store() as PresetStore;
        const layer = this.deps.services.layer();
        const base = store.current();
        return {
            available: !!layer,
            base,
            layer: layer?.get(base) ?? null,
            layerMode: this.router.layerMode(),
            editsToLayer: this.deps.settings.editsToLayer,
            report: layer?.lastReport() ?? null,
            names: store.names(),
            promptNames: this.names(),
            foreign: this.foreign,
            result: this.layerResult,
            canReselect: typeof layer?.reselect === 'function',
            canPrepare: typeof layer?.prepareDisable === 'function',
            scopes:
                typeof layer?.context === 'function'
                    ? {
                          context: layer.context(),
                          editScope: this.router.scope(),
                          canMove: typeof layer.moveOp === 'function',
                      }
                    : undefined,
        };
    }

    /** The scope switch of the block editor (null without the scoped layer). */
    private scopeModel():
        | {
              value: LayerScope;
              context: ReturnType<NonNullable<PresetLayerApi['context']>>;
              onChange(scope: LayerScope): void;
          }
        | undefined {
        const layer = this.deps.services.layer();
        if (typeof layer?.context !== 'function' || !this.deps.settings.editsToLayer) return undefined;
        return {
            value: this.router.scope(),
            context: layer.context(),
            onChange: (scope) => this.setEditScope(scope),
        };
    }

    /** Where new edits go from now on (the editor's and the «Слой» tab's switch). */
    setEditScope(scope: LayerScope): void {
        this.editScope = scope;
        this.renderHeader();
        if (this.tab === 'layer') this.renderTab();
    }

    /** «Пресет этого чата: X» in the header (null without a binding). */
    private bindingBadge(): HTMLElement | null {
        const layer = this.deps.services.layer();
        const text = bindingText(this.app, layer?.bindings?.() ?? null);
        if (!text) return null;
        return el('span', {
            class: 'maestro-m34-badge maestro-m34-badge-layer maestro-m34-binding',
            text,
            title: this.t('m34.binding.hint'),
        });
    }

    /** «Привязать пресет»: binds the current preset to the card or the chat open now, or takes a binding off. */
    async bindDialog(): Promise<void> {
        const layer = this.deps.services.layer();
        const store = this.store();
        if (!layer?.bind || !layer.bindings || !store) return;
        await layer.whenContext?.();
        const current = store.current();
        const bindings = layer.bindings();
        const context = bindings.context;
        const actions: { value: string; label: string }[] = [];
        if (context.chat && bindings.chat !== current)
            actions.push({ value: 'chat', label: this.t('m34.binding.toChat') });
        if (context.character && bindings.character !== current) {
            actions.push({
                value: 'character',
                label: this.t('m34.binding.toCharacter', { character: context.character.name }),
            });
        }
        if (bindings.chat) actions.push({ value: 'unchat', label: this.t('m34.binding.offChat') });
        if (bindings.character) actions.push({ value: 'uncharacter', label: this.t('m34.binding.offCharacter') });
        if (!actions.length) {
            this.app.ui.notice(this.t('m34.binding.noChat'), { urgent: true });
            return;
        }
        const lines = [this.t('m34.binding.body', { name: current })];
        if (bindings.chat) lines.push(this.t('m34.binding.nowChat', { name: bindings.chat }));
        if (bindings.character && context.character) {
            lines.push(
                this.t('m34.binding.nowCharacter', { name: bindings.character, character: context.character.name }),
            );
        }
        const choice = await this.dialogs.choose(this.t('m34.binding.title'), lines.join(' '), actions);
        if (!choice) return;
        const scope = choice === 'chat' || choice === 'unchat' ? 'chat' : 'character';
        const preset = choice === 'chat' || choice === 'character' ? current : null;
        const done = await this.run(async () => {
            await layer.bind?.(scope, preset);
            return true;
        });
        if (done) {
            this.app.ui.notice(
                this.t(preset ? `m34.binding.done.${scope}` : `m34.binding.removed.${scope}`, {
                    name: preset ?? current,
                    character: context.character?.name ?? '',
                }),
                { urgent: true },
            );
        }
        this.rerender();
    }

    layerActions(): LayerActions {
        const layer = () => this.deps.services.layer();
        const base = () => this.store()?.current() ?? '';
        return {
            setEditsToLayer: (on) => {
                this.deps.settings.editsToLayer = on;
                this.deps.saveSettings();
                this.rerender();
            },
            start: () => {
                this.started.add(base());
                this.app.ui.notice(this.t('m34.layer.started', { base: base() }), { urgent: true });
                this.rerender();
            },
            removeOp: async (index) => {
                const api = layer();
                if (!api) return;
                if (
                    !(await this.dialogs.confirm(
                        this.t('m34.layer.removeTitle'),
                        this.t('m34.layer.removeBody'),
                        this.t('m34.dialog.delete'),
                    ))
                )
                    return;
                await this.run(() => api.remove(base(), index));
                this.rerender();
            },
            resolve: async (conflict, choice) => this.resolveConflict(conflict, choice),
            migrate: async (reference) => {
                const api = layer();
                const store = this.store();
                if (!api || !store) return;
                const body = store.saved(reference);
                if (!body) {
                    this.app.ui.notice(this.t('m34.layer.noReference', { name: reference }), {
                        urgent: true,
                        level: 'warn',
                    });
                    return;
                }
                const intro = this.t('m34.layer.migrateBody', { base: base(), reference });
                const edited = api.strip(base(), store.working(), scopesAbove('global'));
                const report = await this.migrateInto(base(), body, edited, intro);
                if (report) this.layerResult = { kind: 'migrate', report };
                this.rerender();
            },
            transfer: async (target) => {
                const api = layer();
                if (!api) return;
                if (
                    !(await this.dialogs.confirm(
                        this.t('m34.layer.transferTitle'),
                        this.t('m34.layer.transferBody', { base: base(), target }),
                    ))
                )
                    return;
                const report = await this.run(() => api.transfer(base(), target));
                if (report) this.layerResult = { kind: 'transfer', report };
                this.rerender();
            },
            importForeign: async () => {
                const api = layer();
                if (!api) return;
                const file = await this.dialogs.pickFile('.json,.settings');
                if (!file) return;
                const body = parsePresetBody(await file.text());
                if (!body) {
                    this.app.ui.notice(this.t('m34.layer.foreignInvalid', { file: file.name }), {
                        urgent: true,
                        level: 'warn',
                    });
                    return;
                }
                const prompts = api.importForeign(body as PresetBody);
                this.foreign = { file: file.name, prompts, picked: new Set() };
                this.rerender();
            },
            pickForeign: (identifier, on) => {
                if (!this.foreign) return;
                if (on) this.foreign.picked.add(identifier);
                else this.foreign.picked.delete(identifier);
                this.rerender();
            },
            addForeign: async () => this.addForeign(),
            clearForeign: () => {
                this.foreign = null;
                this.rerender();
            },
            open: (identifier) => void this.openEditor(identifier),
            setEditScope: (scope) => this.setEditScope(scope),
            moveOp: async (index, scope) => {
                const api = layer();
                if (!api?.moveOp) return;
                await this.run(() => api.moveOp?.(base(), index, scope) ?? Promise.resolve());
                this.rerender();
            },
            reselect: async () => {
                const api = layer();
                const store = this.store();
                if (!api?.reselect || !store) return;
                if (!(await this.canLeave())) return;
                const body = store.draft().dirty ? this.t('m34.layer.reselectDirty') : this.t('m34.layer.reselectBody');
                if (!(await this.dialogs.confirm(this.t('m34.layer.reselect'), body))) return;
                const name = await this.run(() => api.reselect?.() ?? Promise.resolve(null));
                if (name) this.app.ui.notice(this.t('m34.layer.reselected', { name }), { urgent: true });
                this.closeEditor();
                this.rerender();
            },
            prepareDisable: async (mode) => {
                const api = layer();
                if (!api?.prepareDisable) return;
                if (!(await this.canLeave())) return;
                let merged: string | undefined;
                if (mode === 'saveMerged') {
                    const name = await this.dialogs.input(
                        this.t('m34.layer.prepareMerged'),
                        this.t('m34.layerSvc.mergedName', { name: base() }),
                        this.t('m34.layer.prepareMergedBody', { base: base() }),
                    );
                    if (!name) return;
                    merged = name;
                } else {
                    const ok = await this.dialogs.confirm(
                        this.t('m34.layer.prepareTitle'),
                        this.t('m34.layer.prepareBaseBody', { base: base() }),
                    );
                    if (!ok) return;
                }
                const name = await this.run(() => api.prepareDisable?.(mode, merged) ?? Promise.resolve(null));
                if (name) this.app.ui.notice(this.t('m34.layer.prepared', { name }), { urgent: true });
                this.closeEditor();
                this.rerender();
            },
        };
    }

    /**
     * The differences between `reference` and `edited` become operations of the layer of `base`. With the layer's
     * planMigration the user sees them first — block operations listed, body keys ticked one by one (connection keys
     * unticked); keys left out are removed from the layer after migrateFrom (an operation it replaced comes back).
     */
    async migrateInto(
        base: string,
        reference: PresetBody,
        edited: PresetBody,
        intro: string,
        scope: LayerScope = 'global',
    ): Promise<LayerApplyReport | null> {
        const layer = this.deps.services.layer();
        if (!layer) return null;
        let excluded = new Set<string>();
        let plan: { ops: LayerOp[]; report: LayerApplyReport } | null = null;
        try {
            plan = layer.planMigration?.(reference, edited) ?? null;
        } catch (error) {
            this.deps.log.debug('migration preview failed', error);
        }
        if (plan) {
            const preview = renderMigrationPreview(this.app, plan, this.names());
            const content = el('div', {}, [el('p', { text: intro }), preview.content]);
            if (!(await this.dialogs.form(this.t('m34.layer.migrateTitle'), content, this.t('m34.layer.migrateOk'))))
                return null;
            excluded = preview.excluded();
        } else if (!(await this.dialogs.confirm(this.t('m34.layer.migrateTitle'), intro))) {
            return null;
        }
        const keyOps = (ops: readonly LayerOp[]) =>
            new Map(
                ops
                    .filter((op): op is Extract<LayerOp, { op: 'key' }> => op.op === 'key')
                    .map((op) => [op.key, op] as const),
            );
        const before = keyOps(layer.get(base, { scope })?.ops ?? []);
        const report = await this.run(() => layer.migrateFrom(base, reference, edited, scope));
        if (!report) return null;
        this.started.add(base);
        if (excluded.size) {
            await this.run(async () => {
                const ops = layer.get(base)?.ops ?? [];
                const drop = ops
                    .map((op, index) => ({ op, index }))
                    .filter(({ op }) => {
                        if ((op.scope ?? 'global') !== scope) return false;
                        if (op.op !== 'key' || !excluded.has(op.key)) return false;
                        const old = before.get(op.key);
                        return !old || JSON.stringify(old.value) !== JSON.stringify(op.value);
                    })
                    .sort((a, b) => b.index - a.index);
                for (const { op, index } of drop) {
                    await layer.remove(base, index);
                    const old = op.op === 'key' ? before.get(op.key) : undefined;
                    if (old) await layer.record(base, { op: 'key', key: old.key, value: old.value }, scope);
                }
            });
        }
        return report;
    }

    /** Picked blocks of a foreign preset go into the layer (a layer is started for this base if needed). */
    private async addForeign(): Promise<void> {
        const foreign = this.foreign;
        const store = this.store();
        if (!foreign || !store || !this.deps.services.layer()) return;
        this.started.add(store.current());
        const taken = new Set((store.working().prompts ?? []).map((prompt) => prompt.identifier));
        const picked = foreign.prompts.filter((prompt) => foreign.picked.has(prompt.identifier));
        const added = await this.run(async () => {
            let count = 0;
            for (const prompt of picked) {
                const copy: PresetPrompt = { ...structuredClone(prompt), ...userFlagsPatch({ identifier: '' }) };
                if (taken.has(copy.identifier)) copy.identifier = newIdentifier(this.app);
                await this.router.add(copy, anchorFor(this.orderIds(), null) ?? null, false);
                count++;
            }
            return count;
        });
        if (added) {
            this.app.ui.notice(this.t('m34.layer.foreignAdded', { count: added, base: store.current() }), {
                urgent: true,
            });
            this.foreign = null;
        }
        this.rerender();
    }

    private async resolveConflict(conflict: LayerConflict, choice: 'mine' | 'newBase' | 'custom'): Promise<void> {
        const layer = this.deps.services.layer();
        const store = this.store();
        if (!layer || !store) return;
        let resolution: 'mine' | 'newBase' | { text: string } = choice === 'custom' ? 'mine' : choice;
        if (choice === 'custom') {
            const area = el('textarea', { class: 'text_pole maestro-m34-custom-text', attrs: { rows: 14 } });
            area.value = conflict.mine;
            const form = el('div', {}, [
                el('p', { class: 'maestro-field-hint', text: this.t('m34.layer.customHint') }),
                area,
            ]);
            if (!(await this.dialogs.form(this.t('m34.layer.customTitle'), form, this.t('m34.dialog.save')))) return;
            resolution = { text: area.value };
        }
        await this.run(() => layer.resolveConflict(store.current(), conflict.identifier, resolution));
        this.rerender();
    }

    /** Test helper: what the block list shows. */
    listedBlocks(): string[] {
        return [...(this.pane?.querySelectorAll<HTMLElement>('.maestro-m34-block') ?? [])].map(
            (node) => node.dataset.id ?? '',
        );
    }
}

type Loadable = 'map' | 'analysis' | 'versions';

/** The scopes laid over the working copy above `scope` (they stay out of what is moved into it). */
function scopesAbove(scope: LayerScope): LayerScope[] {
    if (scope === 'global') return ['character', 'chat'];
    return scope === 'character' ? ['chat'] : [];
}

/** Touch screens: HTML5 drag would fight scrolling (P-017) — ↑/↓ only. */
function coarsePointer(): boolean {
    try {
        return globalThis.matchMedia?.('(pointer: coarse)').matches === true;
    } catch {
        return false;
    }
}

/** The caret of a text field (number inputs throw on selectionStart in some engines). */
function selectionOf(input: HTMLInputElement | HTMLTextAreaElement | null): number | null {
    try {
        return input?.selectionStart ?? null;
    } catch {
        return null;
    }
}

/** Re-rendering must not steal focus: the focused control (by data-focus-key) comes back with its caret. */
function keepFocus(container: HTMLElement, render: () => void): void {
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && container.contains(active);
    const key = inside ? (active.dataset.focusKey ?? null) : null;
    const input =
        inside && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) ? active : null;
    const start = selectionOf(input);
    render();
    if (!key) return;
    const next = [...container.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
        (node) => node.dataset.focusKey === key,
    );
    if (!next) return;
    next.focus();
    if (start !== null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
        try {
            next.setSelectionRange(start, start);
        } catch {
            // number and search inputs may refuse selection ranges
        }
    }
}

const TAB_ICONS: Record<StudioTab, string> = {
    map: 'fa-diagram-project',
    blocks: 'fa-list-check',
    analysis: 'fa-stethoscope',
    conditional: 'fa-code-branch',
    layer: 'fa-layer-group',
    versions: 'fa-clock-rotate-left',
    params: 'fa-sliders',
    neighbours: 'fa-puzzle-piece',
};
