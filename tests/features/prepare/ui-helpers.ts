// The face of M37 over a fake engine: a PrepareApi whose state, plan, estimate, apply results and «Готово к игре» the
// test sets, with a real user job (app.jobs) for the run, over the ST mock of the preparation tests. Also a fake Ui
// with or without windows and the strip, recording what was registered and opened.
import { SINGLE_SECTIONS, emptyData } from '../../../src/domain/prepare-plan';
import type { AnyPrepareItem, PrepareKind, PreparePlan } from '../../../src/domain/prepare-plan';
import type {
    PrepareApplyOptions,
    PrepareApplySummary,
    PrepareEligibility,
    PrepareEstimateResult,
    PrepareStartOptions,
    PrepareState,
    ReadyStatus,
    SavedPreparationInfo,
    SelectionRow,
    StartScenesInfo,
} from '../../../src/features/prepare/api';
import { PrepareUi } from '../../../src/features/prepare/controller';
import type { PrepareEngine } from '../../../src/features/prepare/controller';
import type {
    MaestroWindowSpec,
    MessageStripProvider,
    OpenWindowOptions,
    PultTab,
    Unsubscribe,
    UserJobHandle,
    WindowContext,
} from '../../../src/shared/contracts';
import { createPrepareEnv } from './helpers';
import type { PrepareEnv } from './helpers';

export function item<K extends PrepareKind>(
    kind: K,
    data: Partial<AnyPrepareItem['data']>,
    extra: Partial<AnyPrepareItem> = {},
): AnyPrepareItem {
    const full = { ...emptyData(kind), ...data } as AnyPrepareItem['data'];
    const name = (full as { name?: string }).name ?? '';
    return {
        id: extra.id ?? (SINGLE_SECTIONS.has(kind) ? kind : `${kind}:${name || kind}`.toLowerCase()),
        kind,
        data: full,
        russian: '',
        sources: ['card.description'],
        scope: 'chat',
        ...extra,
    } as AnyPrepareItem;
}

/** A plan of the harbour story: two characters (one is the player), two places (one exists), a mechanic, a secret. */
export function samplePlan(createdAt = 1000): PreparePlan {
    return {
        version: 1,
        createdAt,
        card: { avatar: 'silver-harbor.png', name: 'Хроники Серебряной Гавани' },
        greeting: 0,
        items: [
            item(
                'world',
                { name: 'Серебряная Гавань', english: 'Silver Harbor', setting: 'A port city' },
                {
                    russian: 'Портовый город на краю империи',
                },
            ),
            item(
                'character',
                {
                    name: 'Элизабет',
                    english: 'Elizabeth',
                    forms: ['Элизабет', 'Лиза'],
                    appearance: 'Red hair, green eyes',
                    present: true,
                },
                {
                    id: 'character:elizabeth',
                    russian: 'Хозяйка таверны, рыжая и острая на язык',
                    conflicts: [
                        { field: 'appearance', with: 'Elizabeth', existing: 'Black hair', proposed: 'Red hair' },
                    ],
                },
            ),
            item(
                'character',
                { name: 'Кай', english: 'Kai', persona: true },
                {
                    id: 'character:kai',
                    russian: 'Твой наёмник',
                    exists: { where: 'persona', label: 'Кай' },
                },
            ),
            item(
                'place',
                { name: 'Ржавый якорь', english: 'Rusty Anchor', parent: 'Серебряная Гавань' },
                {
                    id: 'place:rusty anchor',
                    russian: 'Таверна у причала',
                },
            ),
            item(
                'place',
                { name: 'Старый форт', english: 'Old Fort' },
                {
                    id: 'place:old fort',
                    russian: 'Развалины на холме',
                    exists: { where: 'places', label: 'Old Fort' },
                },
            ),
            item(
                'mechanic',
                {
                    name: 'Репутация',
                    english: 'Reputation',
                    holders: 'characters',
                    attributes: [
                        {
                            name: 'Репутация',
                            english: 'Reputation',
                            kind: 'number',
                            min: 0,
                            max: 100,
                            initial: '50',
                            levels: [],
                            options: [],
                        },
                    ],
                    initial: [{ holder: 'Элизабет', attribute: 'Reputation', value: '60' }],
                },
                { id: 'mechanic:reputation', russian: 'Репутация в городе' },
            ),
            item(
                'secret',
                { text: 'Elizabeth smuggles salt', about: 'Элизабет', knownBy: ['Элизабет'], hiddenFrom: ['Кай'] },
                { id: 'secret:abc', russian: 'Элизабет тайком возит соль' },
            ),
        ],
        sources: [{ id: 'card.description', label: 'Описание карточки', hash: 'h1' }],
        skipped: [],
        fingerprint: 'f',
        chunks: 2,
        failedChunks: 0,
    };
}

export class FakeEngine implements PrepareEngine {
    eligible: PrepareEligibility = { ok: true };
    current: PrepareState = { stage: 'none', jobKey: 'prepare:chat-1' };
    planValue: PreparePlan | null = null;
    saved: SavedPreparationInfo | null = null;
    estimateResult: PrepareEstimateResult = {
        chunks: 3,
        sources: 4,
        skipped: 1,
        inputTokens: 9000,
        outputTokens: 6000,
        usd: 0.02,
        labels: ['Описание карточки', 'Сценарий', 'Твоя персона', 'Velmar Reaches · Silver Harbor'],
        skippedLabels: ['Velmar Reaches · Old Songs'],
        reuse: false,
    };
    readonly estimates: PrepareStartOptions[] = [];
    readonly starts: PrepareStartOptions[] = [];
    readonly applies: { selection: readonly SelectionRow[] | 'all'; options: PrepareApplyOptions }[] = [];
    readonly undos: string[] = [];
    appliedSaved = 0;
    discarded = 0;
    cancelled = 0;
    watching = 0;
    statusValue: ReadyStatus = { ready: true, missing: [], lines: [] };
    scenesInfo: StartScenesInfo = { shown: 0, prepared: [], active: null, locked: false };
    /** What apply() answers (default: every row done with its own journal record). */
    applyAnswer: ((rows: readonly SelectionRow[]) => PrepareApplySummary) | null = null;
    private handle: UserJobHandle | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly env: PrepareEnv) {}

    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }

    isNewChat(): boolean {
        return this.eligible.ok;
    }
    eligibility(): PrepareEligibility {
        return this.eligible;
    }
    state(): PrepareState {
        return { ...this.current };
    }
    plan(): PreparePlan | null {
        return this.planValue ? (JSON.parse(JSON.stringify(this.planValue)) as PreparePlan) : null;
    }
    async load(): Promise<PreparePlan | null> {
        return this.plan();
    }
    async estimate(options: PrepareStartOptions = {}): Promise<PrepareEstimateResult> {
        this.estimates.push(options);
        return { ...this.estimateResult, reuse: options.reuse === true };
    }
    async start(options: PrepareStartOptions = {}): Promise<string | null> {
        this.starts.push(options);
        const key = this.current.jobKey ?? 'prepare:chat-1';
        this.handle = this.env.app.jobs!.start({ key, title: 'Подготовка', cancellable: true });
        this.current = { stage: 'running', jobKey: key };
        this.emit();
        return key;
    }
    /** The run reports a part. */
    progress(done: number, total: number): void {
        this.handle?.progress(done, total, `part ${done}`);
    }
    /** The run ends with a plan. */
    finish(plan: PreparePlan): void {
        this.planValue = plan;
        this.current = { stage: 'ready', jobKey: this.current.jobKey };
        this.handle?.finish('done');
        this.handle = null;
        this.emit();
    }
    async whenDone(): Promise<void> {}
    cancel(): boolean {
        this.cancelled++;
        return this.handle ? this.env.app.jobs!.cancel(this.handle.key) : false;
    }
    async apply(
        selection: readonly SelectionRow[] | 'all',
        options: PrepareApplyOptions = {},
    ): Promise<PrepareApplySummary> {
        this.applies.push({ selection, options });
        const rows = selection === 'all' ? [] : selection;
        const summary = this.applyAnswer
            ? this.applyAnswer(rows)
            : {
                  done: rows.map((row, index) => ({
                      itemId: row.id,
                      kind: (this.planValue?.items.find((one) => one.id === row.id)?.kind ?? 'world') as PrepareKind,
                      text: `${row.id}: в канон`,
                      journalId: `j${index + 1}`,
                  })),
                  skipped: [],
                  failed: [],
                  proposals: [],
              };
        if (summary.done.length) this.current = { stage: 'applied', jobKey: this.current.jobKey, appliedAt: 5000 };
        if (this.planValue) {
            for (const line of summary.done) {
                const target = this.planValue.items.find((one) => one.id === line.itemId);
                if (target) target.exists = { where: 'canon', label: 'Canon' };
            }
        }
        this.emit();
        return summary;
    }
    async undoItem(itemId: string): Promise<boolean> {
        this.undos.push(itemId);
        this.emit();
        return true;
    }
    async savedFor(): Promise<SavedPreparationInfo | null> {
        return this.saved;
    }
    async applySaved(): Promise<PrepareApplySummary> {
        this.appliedSaved++;
        this.current = { stage: 'applied', jobKey: this.current.jobKey, appliedAt: 6000 };
        this.emit();
        return {
            done: [{ itemId: 'character:elizabeth', kind: 'character', text: 'Элизабет: в канон', journalId: 'js' }],
            skipped: [],
            failed: [],
            proposals: [],
        };
    }
    async discard(): Promise<void> {
        this.discarded++;
        this.planValue = null;
        this.current = { stage: 'none', jobKey: this.current.jobKey };
        this.emit();
    }
    async status(): Promise<ReadyStatus> {
        return this.statusValue;
    }
    startScenes(): StartScenesInfo {
        return { ...this.scenesInfo, prepared: [...this.scenesInfo.prepared] };
    }
    describe(target: AnyPrepareItem): string {
        return target.russian || target.id;
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    watch(): Unsubscribe {
        this.watching++;
        return () => {
            this.watching--;
        };
    }
}

export interface UiRecord {
    windows: MaestroWindowSpec[];
    tabs: PultTab[];
    strips: MessageStripProvider[];
    opened: { id: string; options?: OpenWindowOptions }[];
    pult: (string | undefined)[];
}

/** Gives the env's fake Ui windows and the strip (or takes them away) and records what is registered and opened. */
export function shellOf(env: PrepareEnv, options: { windows: boolean; strip?: boolean }): UiRecord {
    const record: UiRecord = { windows: [], tabs: [], strips: [], opened: [], pult: [] };
    const ui = env.ui as unknown as Record<string, unknown>;
    ui.addTab = (tab: PultTab) => {
        record.tabs.push(tab);
        return () => record.tabs.splice(record.tabs.indexOf(tab), 1);
    };
    ui.openPult = (tab?: string) => void record.pult.push(tab);
    ui.windowOfTab = (tab: string) => ({ dossier: 'characters', canon: 'canon', places: 'world' })[tab];
    if (options.windows) {
        ui.addWindow = (spec: MaestroWindowSpec) => {
            record.windows.push(spec);
            return () => record.windows.splice(record.windows.indexOf(spec), 1);
        };
        ui.openWindow = (id: string, open?: OpenWindowOptions) => void record.opened.push({ id, options: open });
    } else {
        delete ui.addWindow;
        delete ui.openWindow;
    }
    if (options.strip !== false) {
        ui.addMessageStripProvider = (provider: MessageStripProvider) => {
            record.strips.push(provider);
            return () => record.strips.splice(record.strips.indexOf(provider), 1);
        };
    } else {
        delete ui.addMessageStripProvider;
    }
    return record;
}

export interface FakeStand {
    env: PrepareEnv;
    engine: FakeEngine;
    ui: PrepareUi;
    shell: UiRecord;
}

export function fakeStand(options: { windows?: boolean; strip?: boolean } = {}): FakeStand {
    const env = createPrepareEnv();
    const shell = shellOf(env, { windows: options.windows ?? true, strip: options.strip ?? true });
    const engine = new FakeEngine(env);
    const ui = new PrepareUi(env.app, engine, env.prepareSettings);
    ui.setMode(options.windows === false ? 'tab' : 'window');
    return { env, engine, ui, shell };
}

export function windowContext(): WindowContext & { titles: string[] } {
    const titles: string[] = [];
    return {
        titles,
        close() {},
        setTitle: (text) => void titles.push(text),
        params: () => ({}),
        onParams: () => () => {},
    };
}

/** Lets the coalesced redraws (60 ms) and the promises behind them run. */
export async function tick(ms = 180): Promise<void> {
    for (let round = 0; round < 3; round++) {
        await new Promise((resolve) => setTimeout(resolve, ms / 3));
        for (let i = 0; i < 10; i++) await Promise.resolve();
    }
}

export function buttons(root: ParentNode): HTMLButtonElement[] {
    return [...root.querySelectorAll('button')];
}

export function buttonOf(root: ParentNode, label: string): HTMLButtonElement {
    const found = buttons(root).find((node) => node.textContent?.trim() === label);
    if (!found) {
        throw new Error(
            `no button «${label}» in [${buttons(root)
                .map((node) => node.textContent)
                .join(' | ')}]`,
        );
    }
    return found;
}

export function hasButton(root: ParentNode, label: string): boolean {
    return buttons(root).some((node) => node.textContent?.trim() === label);
}

export function card(root: ParentNode, itemId: string): HTMLElement {
    const found = root.querySelector<HTMLElement>(`.maestro-m37w-item[data-item="${itemId}"]`);
    if (!found) throw new Error(`no card ${itemId}`);
    return found;
}
