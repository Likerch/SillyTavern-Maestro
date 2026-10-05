import type {
    Autonomy,
    Capabilities,
    CostMeter,
    HealthCheck,
    Host,
    I18n,
    Inbox,
    Journal,
    Logger,
    ModuleManager,
    SettingsSection,
    SettingsService,
    TaskQueue,
    Ui,
    Unsubscribe,
} from '../../shared/contracts';

/** Services the core views render (passed by app.ts to registerCoreViews). */
export interface CoreViewDeps {
    inbox: Inbox;
    journal: Journal;
    autonomy: Autonomy;
    cost: CostMeter;
    modules: ModuleManager;
    settings: SettingsService;
    caps: Capabilities;
    tasks: TaskQueue;
    i18n: I18n;
}

export type NoticeLevel = 'info' | 'warn' | 'error';

export interface NoticeEntry {
    id: number;
    at: number;
    text: string;
    level: NoticeLevel;
    urgent: boolean;
    action?: { label: string; run: () => void };
    /** Urgent notices count in the top-bar badge until the Overview has shown them. */
    seen: boolean;
}

/** What views need from the UI shell besides the services. */
export interface Shell {
    readonly host: Host;
    readonly log: Logger;
    readonly i18n: I18n;
    notice: Ui['notice'];
    confirm: Ui['confirm'];
    openPult(tabId?: string): void;
    closePult(): void;
    /** Re-renders the active tab and badges. */
    refresh(): void;
    /** Updates badges only. */
    updateBadges(): void;
    notices(): readonly NoticeEntry[];
    markNoticesSeen(): void;
    clearNotices(): void;
    healthChecks(): HealthCheck[];
    runWizard(): void;
    scrollToMessage(index: number): void;
    /** Language changed: rebuild every visible string. */
    relocalize(): void;
    /** Subscribes to registry changes that should re-render the settings view (settings sections included). */
    onRegistryChange(listener: () => void): Unsubscribe;
    /** Sections added by modules (Ui.addSettingsSection), sorted by order. */
    settingsSections(): SettingsSection[];
}

export interface ViewEnv extends CoreViewDeps {
    shell: Shell;
}
