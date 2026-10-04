// A fake App for feature tests of M5 «Доктор» and the wizard: the adapter stand (ST mock, lorebooks, world-info.js
// namespace) with real adapters, real Settings and I18n, a UI that captures tabs and wizard steps, and small
// in-memory journal / autonomy / inbox / module registry. Other modules' APIs (rules, guardian, loreJournal) are
// plain fakes exposed through `apis`.
import { vi } from 'vitest';
import { createAdapters } from '../../src/adapters';
import type { Adapters } from '../../src/adapters';
import { compileFind, simulateReplace } from '../../src/domain/doctor-regex';
import { createI18n } from '../../src/core/i18n';
import type { Translations } from '../../src/core/i18n';
import { Settings } from '../../src/core/settings';
import type {
    App,
    AutonomyLevel,
    Capabilities,
    CapabilityReport,
    Decision,
    Inbox,
    Journal,
    JournalAction,
    JournalChange,
    JournalRecord,
    MaestroModule,
    ModuleManager,
    Proposal,
    PultTab,
    Ui,
    UndoHandler,
    Unsubscribe,
    WizardStep,
} from '../../src/shared/contracts';
import type { LoreJournalApi, LoreSummary } from '../../src/features/loreJournal/api';
import type { GuardianApi } from '../../src/features/guardian/api';
import type { RuleDefinition, RuleImpact, RuleState, RulesApi } from '../../src/features/rules/api';
import { UI_STRINGS } from '../../src/ui/views/strings';
import { createStand, silentLog } from './adapters-host';
import type { AdapterStand } from './adapters-host';

export class TestCaps implements Capabilities {
    readonly ok = new Set<string>(['st.regex', 'st.cm', 'st.macros.newEngine']);
    readonly registered = new Map<string, () => boolean | Promise<boolean>>();
    refreshes = 0;
    register(id: string, probe: () => boolean | Promise<boolean>): void {
        this.registered.set(id, probe);
    }
    has(id: string): boolean {
        return this.ok.has(id);
    }
    report(): CapabilityReport[] {
        const ids = new Set([...this.registered.keys(), ...this.ok]);
        return [...ids].map((id) => ({ id, ok: this.ok.has(id), ...(this.ok.has(id) ? {} : { detail: 'missing' }) }));
    }
    async refresh(): Promise<void> {
        this.refreshes += 1;
    }
}

export class CapturingUi implements Ui {
    tabs: PultTab[] = [];
    steps: WizardStep[] = [];
    notices: { text: string; options?: Parameters<Ui['notice']>[1] }[] = [];
    opened: (string | undefined)[] = [];
    closed = 0;
    refreshes = 0;
    styles = new Map<string, string>();
    addTab(tab: PultTab): Unsubscribe {
        this.tabs.push(tab);
        return () => (this.tabs = this.tabs.filter((item) => item !== tab));
    }
    addHealthCheck(): Unsubscribe {
        return () => {};
    }
    addWizardStep(step: WizardStep): Unsubscribe {
        this.steps.push(step);
        return () => (this.steps = this.steps.filter((item) => item !== step));
    }
    addSlashCommand(): Unsubscribe {
        return () => {};
    }
    openPult(tabId?: string): void {
        this.opened.push(tabId);
    }
    closePult(): void {
        this.closed += 1;
    }
    refresh(): void {
        this.refreshes += 1;
    }
    notice(text: string, options?: Parameters<Ui['notice']>[1]): void {
        this.notices.push({ text, options });
    }
    async confirm(): Promise<boolean> {
        return true;
    }
    messageBadge(): Unsubscribe {
        return () => {};
    }
    style(id: string, css: string): Unsubscribe {
        this.styles.set(id, css);
        return () => this.styles.delete(id);
    }
}

export class TestJournal implements Journal {
    records: JournalRecord[] = [];
    handlers = new Map<string, UndoHandler>();
    async record(action: JournalAction): Promise<string> {
        const id = `r${this.records.length + 1}`;
        this.records.push({ ...action, id, at: Date.now(), chatId: 'chat-1' });
        return id;
    }
    async undo(id: string): Promise<boolean> {
        const record = this.records.find((item) => item.id === id);
        if (!record) return false;
        for (const change of [...record.changes].reverse()) {
            const handler = this.handlers.get(change.target);
            if (!handler || !(await handler(change))) return false;
        }
        record.undone = true;
        return true;
    }
    async undoForMessage(): Promise<number> {
        return 0;
    }
    list(): JournalRecord[] {
        return this.records;
    }
    registerUndo(target: string, handler: UndoHandler): void {
        this.handlers.set(target, handler);
    }
}

export class TestInbox implements Inbox {
    appliers = new Map<
        string,
        { apply: (payload: unknown) => Promise<void>; valid?: (payload: unknown) => Promise<boolean> }
    >();
    added: Proposal[] = [];
    registerApplier(
        kind: string,
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
    ): Unsubscribe {
        this.appliers.set(kind, { apply, valid: stillValid });
        return () => this.appliers.delete(kind);
    }
    async add(proposal: Proposal): Promise<string> {
        this.added.push(proposal);
        return 'card';
    }
    list() {
        return [];
    }
    async accept(): Promise<boolean> {
        return true;
    }
    async reject(): Promise<void> {}
    async snooze(): Promise<void> {}
    async invalidateMessage(): Promise<number> {
        return 0;
    }
    onChange(): Unsubscribe {
        return () => {};
    }
    count(): number {
        return this.added.length;
    }
}

export class TestModules implements ModuleManager {
    apis = new Map<string, unknown>();
    list() {
        return [];
    }
    async enable(): Promise<void> {}
    async disable(): Promise<void> {}
    api<T>(key: string): T | undefined {
        return this.apis.get(key) as T | undefined;
    }
    expose(key: string, api: unknown): void {
        this.apis.set(key, api);
    }
}

/** A Rules API fake with real on/off state. */
export class FakeRules implements RulesApi {
    readonly states = new Map<string, RuleState>();
    impact: RuleImpact | Error = {
        before: {
            messageIndex: -1,
            at: 0,
            generationType: 'normal',
            activations: [],
            totalChars: 0,
            totalTokens: 0,
            overflow: false,
        },
        after: {
            messageIndex: -1,
            at: 0,
            generationType: 'normal',
            activations: [],
            totalChars: 0,
            totalTokens: 0,
            overflow: false,
        },
        removed: [{ world: 'Flora', uid: 3, comment: 'Ballroom', chars: 4200 }],
        added: [],
        charsDelta: -4200,
    };
    options = vi.fn<(id: string) => Record<string, unknown> | undefined>(() => undefined);
    setOptions: ((id: string, options: Record<string, unknown>) => Promise<void>) | undefined = undefined;
    readonly switched: [string, boolean][] = [];

    constructor(definitions: Partial<RuleDefinition>[] = []) {
        for (const definition of definitions) this.register(definition as RuleDefinition);
    }
    register(input: RuleDefinition): Unsubscribe {
        const rule: Partial<RuleDefinition> & { id: string } = input;
        const definition: RuleDefinition = {
            titleKey: `rule.${rule.id}`,
            descriptionKey: `rule.${rule.id}.d`,
            owner: 'maestro',
            stage: 1,
            kind: 'lore',
            defaultLevel: 'auto',
            enabledByDefault: true,
            ...rule,
        };
        this.states.set(rule.id, { id: rule.id, enabled: false, definition, lastChanges: [] });
        return () => this.states.delete(rule.id);
    }
    list(): RuleState[] {
        return [...this.states.values()].map((state) => ({ ...state }));
    }
    isEnabled(id: string): boolean {
        return this.states.get(id)?.enabled === true;
    }
    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const state = this.states.get(id);
        if (state) state.enabled = enabled;
        this.switched.push([id, enabled]);
    }
    async compare(): Promise<RuleImpact> {
        if (this.impact instanceof Error) throw this.impact;
        return this.impact;
    }
    suspended(): boolean {
        return false;
    }
}

export function fakeGuardian(has = false): GuardianApi & { taken: string[] } {
    let baseline = has;
    const guardian = {
        taken: [] as string[],
        hasBaseline: () => baseline,
        takeBaseline: async (reason: string) => {
            guardian.taken.push(reason);
            baseline = true;
        },
        drift: async () => [],
        acknowledge: async () => {},
        tabState: () => 'fresh' as const,
    };
    return guardian;
}

export function fakeLoreJournal(summary: Partial<LoreSummary> = {}, turns: unknown[] = []): LoreJournalApi {
    return {
        summary: () => ({
            turns: 0,
            heaviestBooks: [],
            heaviestEntries: [],
            alwaysActive: [],
            neverActive: [],
            avgTotalChars: 0,
            avgCanonChars: 0,
            ...summary,
        }),
        turns: () => turns as ReturnType<LoreJournalApi['turns']>,
    } as unknown as LoreJournalApi;
}

export interface DoctorStand {
    stand: AdapterStand;
    adapters: Adapters;
    app: App;
    ui: CapturingUi;
    caps: TestCaps;
    journal: TestJournal;
    inbox: TestInbox;
    modules: TestModules;
    settings: Settings;
    i18n: Translations;
    /** Autonomy level per kind (default: the proposal's fallback). */
    levels: Record<string, AutonomyLevel>;
    /** `getWorldInfoSettings()` result. */
    wi: Record<string, unknown>;
    /** Regex scripts by type served by the fake engine. */
    regex: { global: Record<string, unknown>[]; preset: Record<string, unknown>[]; scoped: Record<string, unknown>[] };
    /** Types whose scripts ST allows (global always). */
    allowed: Set<'preset' | 'scoped'>;
    opened: string[];
    /** Inits a module like the module manager does; returns its disposer. */
    start<S extends object>(module: MaestroModule<S>): Promise<() => Promise<void>>;
}

export function createDoctorStand(locale: 'ru' | 'en' = 'ru'): DoctorStand {
    const stand = createStand();
    const caps = new TestCaps();
    const host = stand.host as { caps: Capabilities };
    host.caps = caps;
    const adapters = createAdapters(stand.host, silentLog, {
        importModule: stand.importModule,
        fetch: stand.fetchManifest,
    });
    const opened: string[] = [];
    const wi: Record<string, unknown> = {
        world_info_recursive: true,
        world_info_budget: 25,
        world_info_budget_cap: 0,
        world_info_max_recursion_steps: 0,
    };
    Object.assign(stand.worldInfo, {
        getWorldInfoSettings: () => ({ ...wi }),
        openWorldInfoEditor: (name: string) => opened.push(name),
    });
    const regex = {
        global: [] as Record<string, unknown>[],
        preset: [] as Record<string, unknown>[],
        scoped: [] as Record<string, unknown>[],
    };
    const allowed = new Set<'preset' | 'scoped'>();
    const types = { GLOBAL: 0, PRESET: 2, SCOPED: 1 };
    const byCode: Record<number, 'global' | 'preset' | 'scoped'> = { 0: 'global', 2: 'preset', 1: 'scoped' };
    const engine = {
        SCRIPT_TYPES: types,
        getScriptsByType: (code: number, options: { allowedOnly: boolean }) => {
            const type = byCode[code];
            if (!type) return [];
            if (options.allowedOnly && type !== 'global' && !allowed.has(type)) return [];
            return regex[type];
        },
        getRegexScripts: () => [...regex.global, ...regex.preset, ...regex.scoped],
        runRegexScript: (script: Record<string, unknown>, text: string) =>
            simulateReplace(
                {
                    find: String(script.findRegex ?? ''),
                    replace: String(script.replaceString ?? ''),
                    trimStrings: [],
                },
                text,
                compileFind(String(script.findRegex ?? '')),
            ),
    };
    stand.host.modules.regexEngine = async () => engine;

    const i18n = createI18n(() => locale);
    i18n.register(UI_STRINGS);
    const settings = new Settings(
        () => stand.mock.extensionSettings,
        () => {},
        silentLog,
    );
    const ui = new CapturingUi();
    const journal = new TestJournal();
    const inbox = new TestInbox();
    const modules = new TestModules();
    const levels: Record<string, AutonomyLevel> = {};
    const autonomy = {
        level: (kind: string, fallback: AutonomyLevel) => levels[kind] ?? fallback,
        async decide<T>(proposal: Proposal<T>, fallback: AutonomyLevel): Promise<Decision> {
            const level = levels[proposal.kind] ?? fallback;
            if (level === 'off') return 'skipped';
            if (level === 'inbox') {
                await inbox.add(proposal as Proposal);
                return 'queued';
            }
            if (proposal.stillValid && !(await proposal.stillValid())) return 'skipped';
            await proposal.apply(proposal.payload);
            await journal.record({
                module: proposal.module,
                kind: proposal.kind,
                summary: proposal.title,
                changes: proposal.changes,
            });
            return 'applied';
        },
        record: () => {},
        stats: () => [],
        neverAuto: () => {},
    };
    const app = {
        host: stand.host,
        log: silentLog,
        i18n,
        settings,
        journal,
        autonomy,
        inbox,
        ui,
        adapters,
        modules,
        bus: { on: () => () => {}, emit: async () => {} },
    } as unknown as App;

    return {
        stand,
        adapters,
        app,
        ui,
        caps,
        journal,
        inbox,
        modules,
        settings,
        i18n,
        levels,
        wi,
        regex,
        allowed,
        opened,
        async start<S extends object>(module: MaestroModule<S>) {
            if (module.i18n) i18n.register(module.i18n);
            settings.registerModule(module.key, module.defaults as () => object, module.enabledByDefault);
            const disposers: (() => void | Promise<void>)[] = [];
            await module.init({
                app,
                settings: settings.module<S>(module.key),
                log: silentLog,
                own: (dispose) => disposers.push(dispose),
            });
            return async () => {
                for (const dispose of disposers.splice(0).reverse()) await dispose();
                modules.apis.delete(module.key);
            };
        },
    };
}

/** Lets pending promises (async renders, scans with setTimeout pauses) settle. */
export async function flush(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

export type { JournalChange };
