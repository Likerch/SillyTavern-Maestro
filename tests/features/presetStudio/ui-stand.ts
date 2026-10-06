// UI test stand of the Preset Studio (M34): the lore test App (ST mock, host, modules registry, tabs, styles) with
// ST's Popup fakes, a recording Ui, and in-memory fakes of the three contracts the shell codes against —
// PresetStore (store-api.ts), PresetLayerApi (layer-api.ts) and PresetAnalysisApi (analysis-api.ts). The fakes
// mirror the real store where the shell depends on it: reorder never detaches, setEnabled inserts a block that is
// outside the order at the start, addPrompt inserts after `after` (or first), draft = working ≠ saved.
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type {
    MapSlot,
    PresetAnalysisApi,
    PresetFinding,
    ProviderHint,
} from '../../../src/features/presetStudio/analysis-api';
import type { Layer, LayerApplyReport, LayerOp, PresetLayerApi } from '../../../src/features/presetStudio/layer-api';
import { M34_STRINGS } from '../../../src/features/presetStudio/strings';
import type {
    PresetBody,
    PresetDraftState,
    PresetOrderItem,
    PresetPrompt,
    PresetStore,
    PresetVersion,
} from '../../../src/features/presetStudio/store-api';
import type { PresetStudioSettings } from '../../../src/features/presetStudio/studio';
import { defaultPresetStudioSettings } from '../../../src/features/presetStudio/studio';
import type { SlashCommandSpec, Ui } from '../../../src/shared/contracts';
import { createLoreApp } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';
import { FakePopup, POPUP_RESULT, POPUP_TYPE } from '../../helpers/ui-env';

export const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
export const q = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) =>
    scope.querySelector<T>(selector);
export const qa = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) => [
    ...scope.querySelectorAll<T>(selector),
];
export const click = (node: Element | null | undefined) => (node as HTMLElement).click();

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function prompt(identifier: string, fields: Partial<PresetPrompt> = {}): PresetPrompt {
    return {
        identifier,
        name: identifier,
        role: 'system',
        content: `${identifier} text`,
        system_prompt: false,
        marker: false,
        ...fields,
    };
}

/** A small Chat Completion preset: main, a marker, chat history and two user blocks (one off). */
export function presetBody(overrides: Partial<PresetBody> = {}): PresetBody {
    return {
        temperature: 1,
        openai_max_tokens: 300,
        stream_openai: true,
        reasoning_effort: 'auto',
        prompts: [
            prompt('main', { name: 'Main Prompt', system_prompt: true, content: 'Write {{char}}.' }),
            prompt('charDescription', {
                name: 'Char Description',
                system_prompt: true,
                marker: true,
                content: undefined,
            }),
            prompt('chatHistory', { name: 'Chat History', system_prompt: true, marker: true, content: undefined }),
            prompt('style', { name: 'Style', content: 'Use {{if .maestro_scene_combat}}short{{/if}} sentences.' }),
            prompt('extra', { name: 'Extra', content: 'Extra text' }),
            prompt('loose', { name: 'Loose block', content: 'Not listed' }),
        ],
        prompt_order: [
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'charDescription', enabled: true },
                    { identifier: 'style', enabled: true },
                    { identifier: 'extra', enabled: false },
                    { identifier: 'chatHistory', enabled: true },
                ],
            },
        ],
        ...overrides,
    };
}

type Reason = 'prompts' | 'keys' | 'preset' | 'list';

export class FakeStore implements PresetStore {
    readonly files = new Map<string, PresetBody>();
    readonly listOfNames: string[] = [];
    currentName = '';
    work: PresetBody = {};
    readonly calls: { method: string; args: unknown[] }[] = [];
    readonly listeners = new Set<(reason: Reason) => void>();
    versionList: PresetVersion[] = [];
    failNext: string | null = null;

    constructor(presets: Record<string, PresetBody>, current: string) {
        for (const [name, body] of Object.entries(presets)) {
            this.files.set(name, clone(body));
            this.listOfNames.push(name);
        }
        this.currentName = current;
        this.work = clone(this.files.get(current) ?? {});
    }

    private log(method: string, ...args: unknown[]): void {
        this.calls.push({ method, args: clone(args) as unknown[] });
        if (this.failNext === method) {
            this.failNext = null;
            throw new Error(`${method} failed`);
        }
    }

    called(method: string): unknown[][] {
        return this.calls.filter((call) => call.method === method).map((call) => call.args);
    }

    emit(reason: Reason): void {
        for (const listener of [...this.listeners]) listener(reason);
    }

    private order(): PresetOrderItem[] {
        const lists = this.work.prompt_order ?? [];
        let list = lists.find((item) => item.character_id === 100001);
        if (!list) {
            list = { character_id: 100001, order: [] };
            lists.push(list);
            this.work.prompt_order = lists;
        }
        return list.order;
    }

    private setOrder(order: PresetOrderItem[]): void {
        const lists = this.work.prompt_order ?? [];
        const list = lists.find((item) => item.character_id === 100001);
        if (list) list.order = order;
        else this.work.prompt_order = [...lists, { character_id: 100001, order }];
    }

    private promptList(): PresetPrompt[] {
        this.work.prompts ??= [];
        return this.work.prompts;
    }

    names(): string[] {
        return [...this.listOfNames];
    }
    current(): string {
        return this.currentName;
    }
    working(): PresetBody {
        return clone(this.work);
    }
    saved(name: string): PresetBody | null {
        const body = this.files.get(name);
        return body ? clone(body) : null;
    }
    draft(): PresetDraftState {
        const saved = this.files.get(this.currentName) ?? {};
        const dirty = JSON.stringify(saved) !== JSON.stringify(this.work);
        return { dirty, changedPrompts: dirty ? ['x'] : [], changedKeys: [] };
    }
    prompts(): { item: PresetOrderItem; prompt: PresetPrompt | null }[] {
        const byId = new Map(this.promptList().map((item) => [item.identifier, item]));
        return this.order().map((item) => ({ item: { ...item }, prompt: clone(byId.get(item.identifier) ?? null) }));
    }
    async updatePrompt(identifier: string, patch: Partial<PresetPrompt>): Promise<void> {
        this.log('updatePrompt', identifier, patch);
        const target = this.promptList().find((item) => item.identifier === identifier);
        if (!target) throw new Error(`no prompt ${identifier}`);
        Object.assign(target, clone(patch));
        this.emit('prompts');
    }
    async addPrompt(
        block: Omit<PresetPrompt, 'identifier'> & { identifier?: string },
        after?: string,
    ): Promise<string> {
        this.log('addPrompt', block, after);
        const identifier = block.identifier || `new-${this.promptList().length}`;
        const { enabled, ...rest } = block as PresetPrompt & { enabled?: boolean };
        this.promptList().push({ ...clone(rest), identifier } as PresetPrompt);
        const order = this.order();
        const at = after === undefined ? 0 : order.findIndex((item) => item.identifier === after) + 1;
        order.splice(at, 0, { identifier, enabled: after === undefined ? enabled === true : enabled !== false });
        this.emit('prompts');
        return identifier;
    }
    async removePrompt(identifier: string): Promise<void> {
        this.log('removePrompt', identifier);
        this.work.prompts = this.promptList().filter((item) => item.identifier !== identifier);
        this.setOrder(this.order().filter((item) => item.identifier !== identifier));
        this.emit('prompts');
    }
    async setEnabled(identifiers: string[], enabled: boolean): Promise<void> {
        this.log('setEnabled', identifiers, enabled);
        const order = this.order();
        for (const identifier of identifiers) {
            const entry = order.find((item) => item.identifier === identifier);
            if (entry) entry.enabled = enabled;
            else if (this.promptList().some((item) => item.identifier === identifier))
                order.unshift({ identifier, enabled });
        }
        this.emit('prompts');
    }
    async reorder(identifiers: string[]): Promise<void> {
        this.log('reorder', identifiers);
        const order = this.order();
        const byId = new Map(order.map((item) => [item.identifier, item]));
        const next: PresetOrderItem[] = [];
        for (const identifier of identifiers) {
            const entry = byId.get(identifier);
            if (entry && !next.includes(entry)) next.push(entry);
        }
        for (const entry of order) if (!next.includes(entry)) next.push(entry);
        this.setOrder(next);
        this.emit('prompts');
    }
    async setKeys(patch: Record<string, unknown>): Promise<void> {
        this.log('setKeys', patch);
        Object.assign(this.work, clone(patch));
        this.emit('keys');
    }
    async save(name?: string, summary?: string): Promise<void> {
        this.log('save', name, summary);
        this.files.set(name ?? this.currentName, clone(this.work));
        this.emit('list');
    }
    async saveAs(name: string): Promise<string> {
        this.log('saveAs', name);
        this.files.set(name, clone(this.work));
        if (!this.listOfNames.includes(name)) this.listOfNames.push(name);
        this.currentName = name;
        this.emit('list');
        return name;
    }
    async rename(oldName: string, newName: string): Promise<void> {
        this.log('rename', oldName, newName);
        const body = this.files.get(oldName);
        this.files.delete(oldName);
        if (body) this.files.set(newName, body);
        this.listOfNames.splice(this.listOfNames.indexOf(oldName), 1, newName);
        if (this.currentName === oldName) this.currentName = newName;
        this.emit('list');
    }
    async remove(name: string): Promise<void> {
        this.log('remove', name);
        this.files.delete(name);
        this.listOfNames.splice(this.listOfNames.indexOf(name), 1);
        await this.select(this.listOfNames[0] ?? '');
    }
    async select(name: string): Promise<void> {
        this.log('select', name);
        this.currentName = name;
        this.work = clone(this.files.get(name) ?? {});
        this.emit('preset');
    }
    async importFile(file: File): Promise<string> {
        this.log('importFile', file.name);
        const name = file.name.replace(/\.[^.]+$/, '');
        this.files.set(name, JSON.parse(await file.text()) as PresetBody);
        this.listOfNames.push(name);
        await this.select(name);
        return name;
    }
    async exportPreset(name: string, options?: { withSensitive?: boolean }): Promise<void> {
        this.log('exportPreset', name, options);
    }
    async versions(name: string): Promise<PresetVersion[]> {
        this.log('versions', name);
        return clone(this.versionList);
    }
    async restoreVersion(name: string, versionId: string): Promise<void> {
        this.log('restoreVersion', name, versionId);
        const version = this.versionList.find((item) => item.id === versionId);
        if (version) {
            this.files.set(name, clone(version.body));
            this.work = clone(version.body);
        }
        this.emit('preset');
    }
    onChange(listener: (reason: Reason) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export class FakeLayer implements PresetLayerApi {
    readonly layers = new Map<string, LayerOp[]>();
    readonly recorded: { base: string; op: LayerOp }[] = [];
    readonly removed: { base: string; index: number }[] = [];
    readonly resolved: { base: string; identifier: string; choice: unknown }[] = [];
    readonly migrations: { base: string; reference: PresetBody; edited: PresetBody }[] = [];
    readonly transfers: { from: string; to: string }[] = [];
    readonly listeners = new Set<() => void>();
    report: LayerApplyReport | null = null;
    reselect = vi.fn(async (name?: string) => name ?? 'Marinara');
    prepareDisable = vi.fn(async (mode: 'reselectBase' | 'saveMerged') =>
        mode === 'saveMerged' ? 'Merged' : 'Marinara',
    );
    /** What planMigration plans and migrateFrom writes (merged by block and key, like the real layer). */
    planOps: LayerOp[] = [
        { op: 'toggle', identifier: 'extra', enabled: true },
        { op: 'key', key: 'temperature', value: 0.5 },
        { op: 'key', key: 'openrouter_model', value: 'deepseek/deepseek-v4' },
    ];
    planMigration = vi.fn((): { ops: LayerOp[]; report: LayerApplyReport } => ({
        ops: clone(this.planOps),
        report: { applied: this.planOps.length, conflicts: [], orphaned: [] },
    }));

    get(base: string): Layer | null {
        const ops = this.layers.get(base);
        return ops && ops.length
            ? { base, ops: clone(ops).map((op) => ({ ...op, scope: 'global' as const })), updatedAt: 1 }
            : null;
    }
    async record(base: string, op: LayerOp): Promise<void> {
        this.recorded.push({ base, op: clone(op) });
        const ops = this.layers.get(base) ?? [];
        ops.push(clone(op));
        this.layers.set(base, ops);
    }
    async remove(base: string, index: number): Promise<void> {
        this.removed.push({ base, index });
        this.layers.get(base)?.splice(index, 1);
    }
    apply(_base: string, body: PresetBody): { body: PresetBody; report: LayerApplyReport } {
        return { body, report: { applied: 0, conflicts: [], orphaned: [] } };
    }
    strip(_base: string, body: PresetBody): PresetBody {
        return body;
    }
    async resolveConflict(
        base: string,
        identifier: string,
        choice: 'mine' | 'newBase' | { text: string },
    ): Promise<void> {
        this.resolved.push({ base, identifier, choice });
    }
    async migrateFrom(base: string, reference: PresetBody, edited: PresetBody): Promise<LayerApplyReport> {
        this.migrations.push({ base, reference, edited });
        const ops = this.layers.get(base) ?? [];
        const keyOf = (op: LayerOp) =>
            op.op === 'key' ? 'key:' + op.key : op.op + ':' + (op.op === 'add' ? op.prompt.identifier : op.identifier);
        for (const op of this.planOps) {
            const at = ops.findIndex((item) => keyOf(item) === keyOf(op));
            if (at >= 0) ops[at] = clone(op);
            else ops.push(clone(op));
        }
        this.layers.set(base, ops);
        return { applied: this.planOps.length, conflicts: [], orphaned: [], removed: ['extra'] };
    }
    async transfer(fromBase: string, toBase: string): Promise<LayerApplyReport> {
        this.transfers.push({ from: fromBase, to: toBase });
        return { applied: 1, conflicts: [], orphaned: [] };
    }
    importForeign(body: PresetBody): PresetPrompt[] {
        return clone(body.prompts ?? []);
    }
    lastReport(): LayerApplyReport | null {
        return this.report;
    }
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export class FakeAnalysis implements PresetAnalysisApi {
    slots: MapSlot[] = [];
    list: PresetFinding[] = [];
    hintList: ProviderHint[] = [];
    readonly options: unknown[] = [];
    async map(_body?: PresetBody, options?: unknown): Promise<MapSlot[]> {
        this.options.push(options);
        return clone(this.slots);
    }
    async findings(_body?: PresetBody, options?: unknown): Promise<PresetFinding[]> {
        this.options.push(options);
        return clone(this.list);
    }
    hints(): ProviderHint[] {
        return clone(this.hintList);
    }
}

export interface Stand {
    lore: LoreTestApp;
    app: LoreTestApp['app'];
    store: FakeStore;
    layer: FakeLayer;
    analysis: FakeAnalysis;
    settings: PresetStudioSettings;
    notices: { text: string; options?: Parameters<Ui['notice']>[1] }[];
    slash: SlashCommandSpec[];
    callGenericPopup: Mock<
        (content: unknown, type: number, input?: string, options?: Record<string, unknown>) => Promise<unknown>
    >;
    /** The text of each generic popup shown, in order. */
    popupTexts: string[];
    /** Queues the next generic popup results (then AFFIRMATIVE); a function gets the content and returns one. */
    answer(...results: unknown[]): void;
    /** Exposes the fakes like the module does. */
    expose(parts?: { layer?: boolean; analysis?: boolean }): void;
}

export const CUSTOM = 100;

export function createStand(options: { presets?: Record<string, PresetBody>; current?: string } = {}): Stand {
    document.body.replaceChildren();
    FakePopup.instances = [];
    const lore = createLoreApp({ locale: 'en' });
    lore.caps.add('st.oai.promptManager');
    lore.caps.add('st.presetManager');
    lore.app.i18n.register(M34_STRINGS);
    const ctx = lore.ctx;
    const queue: unknown[] = [];
    const popupTexts: string[] = [];
    const callGenericPopup = vi.fn(async (content: unknown): Promise<unknown> => {
        popupTexts.push(content instanceof HTMLElement ? (content.textContent ?? '') : String(content));
        if (!queue.length) return POPUP_RESULT.AFFIRMATIVE;
        const next = queue.shift();
        // A function answers by looking at (and filling) the popup's content.
        return typeof next === 'function' ? (next as (node: unknown) => unknown)(content) : next;
    });
    Object.assign(ctx, { Popup: FakePopup, POPUP_TYPE, POPUP_RESULT, callGenericPopup });
    const notices: Stand['notices'] = [];
    const slash: SlashCommandSpec[] = [];
    Object.assign(lore.app.ui, {
        notice: (text: string, noticeOptions?: Parameters<Ui['notice']>[1]) =>
            notices.push({ text, options: noticeOptions }),
        addSlashCommand: (command: SlashCommandSpec) => {
            slash.push(command);
            return () => {
                const index = slash.indexOf(command);
                if (index >= 0) slash.splice(index, 1);
            };
        },
        closePult: () => {},
        confirm: async () => true,
    });
    const presets = options.presets ?? { Marinara: presetBody(), Yablochny: presetBody({ temperature: 0.7 }) };
    const store = new FakeStore(presets, options.current ?? 'Marinara');
    const layer = new FakeLayer();
    const analysis = new FakeAnalysis();
    const stand: Stand = {
        lore,
        app: lore.app,
        store,
        layer,
        analysis,
        settings: defaultPresetStudioSettings(),
        notices,
        slash,
        callGenericPopup,
        popupTexts,
        answer: (...results) => queue.push(...results),
        expose(parts = {}) {
            lore.app.modules.expose('presetStore', store);
            if (parts.layer !== false) lore.app.modules.expose('presetLayer', layer);
            if (parts.analysis !== false) lore.app.modules.expose('presetAnalysis', analysis);
        },
    };
    return stand;
}

/** ST's AI Response Configuration markup around Prompt Manager (index.html 2273-2276). */
export function buildPmDom(withContainer = true): HTMLElement {
    const settings = document.createElement('div');
    settings.id = 'openai_settings';
    const block = document.createElement('div');
    block.className = 'range-block m-b-1';
    if (withContainer) {
        const container = document.createElement('div');
        container.id = 'completion_prompt_manager';
        container.textContent = 'PM';
        block.append(container);
    }
    settings.append(block);
    document.body.append(settings);
    return block;
}
