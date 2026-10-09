// Maestro's UI shell: windows (plan-2 §10; the pult tabs became their sections), the Maestro menu and entry points,
// notices, confirmations, the strip under chat messages (with the memory-only lines of Ui.messageBadge), the message
// button, styles, slash commands, health checks and the first-run wizard. Core views and the Inbox's strip provider are
// registered by app.ts after mount().
import type {
    ComposerGroup,
    HealthCheck,
    Host,
    I18n,
    Logger,
    MaestroWindowSpec,
    MessageBadgeSpec,
    MessageStripProvider,
    NoticeImportance,
    NoticeOptions,
    NotifyLevel,
    OpenWindowOptions,
    PultTab,
    SettingsSection,
    SettingsService,
    SlashCommandSpec,
    StripItem,
    Ui,
    Unsubscribe,
    WizardStep,
} from '../shared/contracts';
import { detailsView } from './components/diff';
import { el, prefersReducedMotion, setButtonErrorHandler } from './components/dom';
import { ComposerActions } from './views/composer';
import { coreCommands } from './views/core-commands';
import { EntryPoints } from './views/entry-points';
import { healthTab } from './views/health';
import { inboxTab } from './views/inbox';
import { inboxStripProvider } from './views/inbox-strip';
import { journalTab } from './views/journal';
import { MessageButtons } from './views/message-button';
import { MessageStrip } from './views/message-strip';
import { overviewTab } from './views/overview';
import { onRegistryChange } from './views/registries';
import { settingsTab } from './views/settings';
import { SlashCommands } from './views/slash-commands';
import { UI_STRINGS } from './views/strings';
import { tasksTab } from './views/tasks';
import type { CoreViewDeps, NoticeEntry, NoticeLevel, Shell } from './views/types';
import { Wizard } from './views/wizard';
import { BUILTIN_WINDOWS } from './windows/builtin';
import { MainMenu } from './windows/main-menu';
import { WindowManager } from './windows/manager';
import { FloatingMenu } from './windows/menu';
import type { MenuItem } from './windows/menu';
import { MAESTRO_WINDOW, TabRegistry } from './windows/sections';

export { registerProfileTask, registerSettingsAction } from './views/registries';
export type { SettingsAction } from './views/registries';
export type { CoreViewDeps } from './views/types';
export { MAESTRO_WINDOW } from './windows/sections';

/** What the message menu needs from the dossier module (its api.ts, duck-typed: ui does not import features). */
interface DossierOpener {
    open?(entityId: string): void;
    openByName?(name: string): boolean;
}

export interface UiDeps {
    host: Host;
    i18n: I18n;
    settings: SettingsService;
    log: Logger;
}

export interface UiImpl extends Ui {
    mount(): void;
    dispose(): void;
    registerCoreViews(deps: CoreViewDeps): void;
    /** Unlike the contract (void), returns a remover: the command then answers "module is off". */
    addSlashCommand(command: SlashCommandSpec): Unsubscribe;
    closePult(): void;
    addSettingsSection(section: SettingsSection): Unsubscribe;
    addWindow(spec: MaestroWindowSpec): Unsubscribe;
    openWindow(id: string, options?: OpenWindowOptions): void;
    closeWindow(id: string): void;
    isWindowOpen(id: string): boolean;
    windowOfTab(tabId: string): string | undefined;
    addMessageStripProvider(provider: MessageStripProvider): Unsubscribe;
    addComposerAction(group: ComposerGroup): Unsubscribe;
    prompt(title: string, options?: { value?: string; hint?: string }): Promise<string | null>;
    /** Opens the first-run wizard if it has not been completed (also runs by itself after APP_READY). */
    runFirstRunWizardIfNeeded(): boolean;
    /** Re-opens the windows that were open on this device (app.ts, once, after the modules started). */
    restoreWindows(): void;
}

const MAX_NOTICES = 50;
/** Lets modules register their wizard steps (modules start after mount) before the wizard opens. */
const WIZARD_DELAY_MS = 1500;

const TOAST: Record<NoticeLevel, 'info' | 'warning' | 'error'> = { info: 'info', warn: 'warning', error: 'error' };
const SEVERITY: Record<NoticeLevel, number> = { info: 0, warn: 1, error: 2 };
const RANK: Record<NoticeImportance, number> = { info: 0, important: 1, urgent: 2 };
/** Lowest importance that pops up as a toast at each notification level. */
const THRESHOLD: Record<NotifyLevel, NoticeImportance> = { all: 'info', important: 'important', urgent: 'urgent' };
/** ST events that start a new turn for notice grouping (keys of eventTypes). */
const TURN_EVENTS = ['MESSAGE_SENT', 'CHAT_CHANGED'];

type NoticeAction = { label: string; run: () => void };

/** A merged group of notices within one turn (NoticeOptions.group). */
interface NoticeGroup {
    entry: NoticeEntry;
    texts: string[];
    actions: NoticeAction[];
    groupText?: (count: number) => string;
}

/** The importance a notice gets when the caller did not say. */
export function noticeImportance(options: NoticeOptions): NoticeImportance {
    if (options.importance) return options.importance;
    if (options.urgent) return 'urgent';
    return options.level === 'warn' || options.level === 'error' ? 'important' : 'info';
}

/** Whether a notice of this importance pops up as a toast at the user's level. */
export function passesLevel(importance: NoticeImportance, level: NotifyLevel | undefined): boolean {
    return RANK[importance] >= RANK[THRESHOLD[level ?? 'all'] ?? 'info'];
}

class MaestroUi implements UiImpl, Shell {
    readonly host: Host;
    readonly log: Logger;
    readonly i18n: I18n;
    private readonly settings: SettingsService;
    private readonly tabs: TabRegistry;
    private readonly windows: WindowManager;
    private readonly menu: FloatingMenu;
    private readonly mainMenu: MainMenu;
    private readonly wizard: Wizard;
    private readonly entries: EntryPoints;
    private readonly messageButtons: MessageButtons;
    private readonly strip: MessageStrip;
    private readonly composer: ComposerActions;
    private readonly slash: SlashCommands;
    /** Services of the core views (jobs, modules…), known after registerCoreViews. */
    private coreDeps: CoreViewDeps | null = null;
    private readonly checks = new Map<string, HealthCheck>();
    private readonly sections = new Map<string, SettingsSection>();
    private readonly sectionListeners = new Set<() => void>();
    private readonly styles = new Map<string, HTMLStyleElement>();
    private readonly noticeList: NoticeEntry[] = [];
    private readonly noticeGroups = new Map<string, NoticeGroup>();
    /** Toast element per notice id (a merged group replaces its toast). */
    private readonly toasts = new Map<number, unknown>();
    /** Bumped when the user sends a message or the chat changes: groups merge only within one turn. */
    private turn = 0;
    private readonly unsubscribers: Unsubscribe[] = [];
    private readonly coreTabs: Unsubscribe[] = [];
    private wizardTimer: ReturnType<typeof setTimeout> | null = null;
    /** The first-run check already ran (explicitly or by the timer): never auto-open twice per page. */
    private wizardChecked = false;
    private nextNotice = 1;
    private mounted = false;
    private disposed = false;

    constructor(deps: UiDeps) {
        this.host = deps.host;
        this.log = deps.log;
        this.i18n = deps.i18n;
        this.settings = deps.settings;
        this.tabs = new TabRegistry(this.log);
        this.windows = new WindowManager({
            i18n: this.i18n,
            log: this.log,
            tabs: this.tabs,
            onChange: () => this.windowsChanged(),
        });
        this.menu = new FloatingMenu(this.log);
        this.mainMenu = new MainMenu({
            i18n: this.i18n,
            windows: this.windows,
            menu: this.menu,
            jobs: () => this.coreDeps?.jobs,
            // The quick actions of the button at the message box are listed in the Maestro menu as well.
            extra: () => this.composer.menuGroups(),
        });
        this.wizard = new Wizard({
            host: this.host,
            i18n: this.i18n,
            log: this.log,
            settings: this.settings,
            onFinished: (skipped) => {
                if (!skipped) this.notice(this.i18n.t('ui.wizard.finished'), { level: 'info' });
            },
        });
        this.entries = new EntryPoints({
            i18n: this.i18n,
            log: this.log,
            menu: (anchor) => {
                if (!this.disposed) this.mainMenu.toggle(anchor);
            },
            openMain: () => this.openWindow(MAESTRO_WINDOW),
        });
        this.messageButtons = new MessageButtons({
            host: this.host,
            i18n: this.i18n,
            log: this.log,
            menu: this.menu,
            items: (index) => this.messageMenu(index),
        });
        const actionFailed = (error: unknown) =>
            this.notice(
                this.i18n.t('ui.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
                { level: 'error' },
            );
        this.strip = new MessageStrip({
            host: this.host,
            i18n: this.i18n,
            settings: this.settings,
            log: this.log,
            open: (target) => this.openTarget(target),
            onError: actionFailed,
        });
        this.composer = new ComposerActions({
            host: this.host,
            i18n: this.i18n,
            log: this.log,
            settings: this.settings,
            menu: this.menu,
            onError: actionFailed,
        });
        this.slash = new SlashCommands(this.host, this.i18n, this.log);
        setButtonErrorHandler((error) => {
            this.log.error('action failed', error);
            actionFailed(error);
        });
        // Last: adding a window reports back through windowsChanged(), which needs the entry points.
        for (const spec of BUILTIN_WINDOWS) this.windows.add(spec);
    }

    /* ---------------------------------------------------------------- lifecycle */

    mount(): void {
        if (this.mounted || this.disposed) return;
        this.mounted = true;
        this.entries.mount();
        this.messageButtons.mount();
        this.composer.mount();
        this.updateBadges();
        for (const event of TURN_EVENTS) this.listen(event, () => this.nextTurn());
        this.listen('APP_READY', () => {
            // ST builds some containers late; and APP_READY auto-fires for late listeners (lib/eventemitter.js).
            this.entries.mount();
            this.messageButtons.mount();
            this.composer.mount();
            this.updateBadges();
            if (this.wizardTimer === null && !this.wizardChecked && !this.settings.core().firstRunDone) {
                this.wizardTimer = setTimeout(() => {
                    this.wizardTimer = null;
                    if (!this.disposed) this.runFirstRunWizardIfNeeded();
                }, WIZARD_DELAY_MS);
            }
        });
    }

    registerCoreViews(deps: CoreViewDeps): void {
        for (const unsubscribe of this.coreTabs.splice(0)) unsubscribe();
        this.coreDeps = deps;
        const env = { ...deps, shell: this as Shell };
        for (const tab of [
            overviewTab(env),
            inboxTab(env),
            healthTab(env),
            tasksTab(env),
            journalTab(env),
            settingsTab(env),
        ]) {
            this.coreTabs.push(this.addTab(tab));
        }
        this.coreTabs.push(deps.inbox.onChange(() => this.updateBadges()));
        this.coreTabs.push(this.strip.addProvider(inboxStripProvider(env)));
        const jobs = deps.jobs;
        if (jobs) {
            this.entries.setJobs(jobs.list());
            this.coreTabs.push(
                jobs.on(() => {
                    this.entries.setJobs(jobs.list());
                    this.mainMenu.refresh();
                }),
                () => this.entries.setJobs([]),
            );
        }
        for (const command of coreCommands({
            i18n: this.i18n,
            log: this.log,
            settings: this.settings,
            journal: deps.journal,
            windows: this.windows,
            tabs: this.tabs,
            notice: (text, options) => this.notice(text, options),
            confirm: (title, body, options) => this.confirm(title, body, options),
            openMenu: () => {
                const anchor = this.entries.topAnchor();
                if (!anchor) return false;
                this.mainMenu.open(anchor);
                return true;
            },
        })) {
            this.coreTabs.push(this.addSlashCommand(command));
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.wizardTimer !== null) clearTimeout(this.wizardTimer);
        this.wizardTimer = null;
        for (const unsubscribe of [...this.coreTabs.splice(0), ...this.unsubscribers.splice(0)]) {
            try {
                unsubscribe();
            } catch (error) {
                this.log.warn('ui dispose', error);
            }
        }
        this.wizard.dispose();
        this.menu.dispose();
        this.windows.dispose();
        this.tabs.clear();
        this.entries.dispose();
        this.messageButtons.dispose();
        this.composer.dispose();
        this.strip.dispose();
        this.slash.dispose();
        for (const node of this.styles.values()) node.remove();
        this.styles.clear();
        this.checks.clear();
        this.sections.clear();
        this.sectionListeners.clear();
        this.noticeList.length = 0;
        this.noticeGroups.clear();
        this.toasts.clear();
        this.coreDeps = null;
    }

    /* ---------------------------------------------------------------- Ui contract */

    addTab(tab: PultTab): Unsubscribe {
        if (this.disposed) return () => {};
        return this.tabs.add(tab);
    }

    addWindow(spec: MaestroWindowSpec): Unsubscribe {
        if (this.disposed) return () => {};
        return this.windows.add(spec);
    }

    openWindow(id: string, options?: OpenWindowOptions): void {
        if (this.disposed) return;
        this.menu.close();
        this.windows.open(id, options);
    }

    closeWindow(id: string): void {
        this.windows.close(id);
    }

    isWindowOpen(id: string): boolean {
        return this.windows.isOpen(id);
    }

    windowOfTab(tabId: string): string | undefined {
        return this.windows.windowOfTab(tabId);
    }

    restoreWindows(): void {
        if (!this.disposed) this.windows.restore();
    }

    addHealthCheck(check: HealthCheck): Unsubscribe {
        this.checks.set(check.id, check);
        return () => {
            if (this.checks.get(check.id) === check) this.checks.delete(check.id);
        };
    }

    addWizardStep(step: WizardStep): Unsubscribe {
        return this.wizard.add(step);
    }

    addSlashCommand(command: SlashCommandSpec): Unsubscribe {
        if (this.disposed) return () => {};
        return this.slash.add(command);
    }

    /** The pult is gone (plan-2 §10): opens the window that shows the tab, on that section. */
    openPult(tabId?: string): void {
        if (this.disposed) return;
        this.menu.close();
        this.windows.openTab(tabId);
    }

    /** Makes room for the chat: on a phone the visible window closes; desktop windows do not cover the chat. */
    closePult(): void {
        this.menu.close();
        this.windows.yieldToChat();
    }

    refresh(): void {
        this.windows.refresh();
    }

    notice(text: string, options: NoticeOptions = {}): void {
        const level = options.level ?? 'info';
        const importance = noticeImportance(options);
        const urgent = importance === 'urgent';
        if (level === 'error') this.log.warn('notice:', text);
        else this.log.info('notice:', text);
        const merged = options.group ? this.mergeNotice(options.group, text, level, importance, options.action) : null;
        const entry =
            merged ??
            this.addNotice({
                id: this.nextNotice++,
                at: Date.now(),
                text,
                level,
                importance,
                urgent,
                action: options.action,
                seen: !urgent,
                turn: this.turn,
                count: 1,
                ...(options.group ? { group: options.group } : {}),
            });
        if (options.group && !merged) {
            this.noticeGroups.set(options.group, {
                entry,
                texts: [text],
                actions: options.action ? [options.action] : [],
                groupText: options.groupText,
            });
        }
        if (passesLevel(entry.importance, this.settings.core().notifyLevel)) this.toast(entry);
        this.updateBadges();
        this.windows.rerenderTab('overview');
    }

    async confirm(title: string, body: string | HTMLElement, options: { details?: string } = {}): Promise<boolean> {
        try {
            const c = this.host.ctx();
            const content = el('div', { class: 'maestro-confirm' }, [
                el('h3', { class: 'maestro-confirm-title', text: title }),
                typeof body === 'string' ? el('div', { class: 'maestro-confirm-body', text: body }) : body,
                options.details
                    ? detailsView(this.i18n, this.settings.core().showTechnical === true, [
                          el('div', { class: 'maestro-details-notes', text: options.details }),
                      ])
                    : null,
            ]);
            const result = await c.callGenericPopup(content, c.POPUP_TYPE.CONFIRM, '', {
                okButton: this.i18n.t('ui.confirm.yes'),
                cancelButton: this.i18n.t('ui.confirm.no'),
                leftAlign: true,
            });
            return result === c.POPUP_RESULT.AFFIRMATIVE;
        } catch (error) {
            this.log.error('confirm failed', error);
            return false;
        }
    }

    /** Back-compat adapter: a memory-only line of the strip under the message. */
    messageBadge(messageIndex: number, badge: MessageBadgeSpec): Unsubscribe {
        if (this.disposed) return () => {};
        return this.strip.badge(messageIndex, badge);
    }

    addMessageStripProvider(provider: MessageStripProvider): Unsubscribe {
        if (this.disposed) return () => {};
        return this.strip.addProvider(provider);
    }

    addComposerAction(group: ComposerGroup): Unsubscribe {
        if (this.disposed) return () => {};
        const off = this.composer.add(group);
        this.mainMenu.refresh();
        return () => {
            off();
            this.mainMenu.refresh();
        };
    }

    async prompt(title: string, options: { value?: string; hint?: string } = {}): Promise<string | null> {
        try {
            const c = this.host.ctx();
            const content = el('div', { class: 'maestro-confirm maestro-prompt' }, [
                el('h3', { class: 'maestro-confirm-title', text: title }),
                options.hint ? el('div', { class: 'maestro-confirm-body maestro-muted', text: options.hint }) : null,
            ]);
            const result = await c.callGenericPopup(content, c.POPUP_TYPE.INPUT, options.value ?? '', {
                okButton: this.i18n.t('ui.prompt.ok'),
                cancelButton: this.i18n.t('ui.prompt.cancel'),
                leftAlign: true,
            });
            if (typeof result !== 'string') return null;
            const text = result.trim();
            return text || null;
        } catch (error) {
            this.log.error('prompt failed', error);
            return null;
        }
    }

    style(id: string, css: string): Unsubscribe {
        if (this.disposed) return () => {};
        let node = this.styles.get(id);
        if (!node || !node.isConnected) {
            node = el('style', { attrs: { 'data-maestro-style': id } });
            document.head.appendChild(node);
            this.styles.set(id, node);
        }
        node.textContent = css;
        const owned = node;
        return () => {
            if (this.styles.get(id) !== owned) return;
            owned.remove();
            this.styles.delete(id);
        };
    }

    addSettingsSection(section: SettingsSection): Unsubscribe {
        if (this.disposed) return () => {};
        if (this.sections.has(section.id)) this.log.warn(`settings section "${section.id}" replaced`);
        this.sections.set(section.id, section);
        this.sectionsChanged();
        return () => {
            if (this.sections.get(section.id) !== section) return;
            this.sections.delete(section.id);
            this.sectionsChanged();
        };
    }

    /* ---------------------------------------------------------------- Shell (for views) */

    updateBadges(): void {
        // The window manager calls back windowsChanged(), which sets the top-bar badge and the open menu.
        this.windows.updateBadges();
    }

    notices(): readonly NoticeEntry[] {
        return this.noticeList;
    }

    markNoticesSeen(): void {
        let changed = false;
        for (const entry of this.noticeList) {
            if (!entry.seen) {
                entry.seen = true;
                changed = true;
            }
        }
        if (changed) this.updateBadges();
    }

    clearNotices(): void {
        this.noticeList.length = 0;
        this.noticeGroups.clear();
        this.updateBadges();
    }

    healthChecks(): HealthCheck[] {
        return [...this.checks.values()];
    }

    runWizard(): void {
        if (this.disposed) return;
        this.wizard.open();
    }

    runFirstRunWizardIfNeeded(): boolean {
        if (this.disposed) return false;
        // An explicit call (app.ts after modules started) supersedes the APP_READY fallback timer.
        if (this.wizardTimer !== null) clearTimeout(this.wizardTimer);
        this.wizardTimer = null;
        this.wizardChecked = true;
        return this.wizard.maybeRun();
    }

    scrollToMessage(index: number): void {
        this.closePult();
        const node = document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"]`);
        if (node) {
            this.flash(node);
            return;
        }
        // Not rendered (lazy loading): /chat-jump loads older messages first (ST 1.19 slash-commands.js).
        const c = this.host.ctx();
        if (typeof c.executeSlashCommandsWithOptions !== 'function') return;
        void c
            .executeSlashCommandsWithOptions(`/chat-jump ${index}`, { handleExecutionErrors: true })
            .then(() => {
                const loaded = document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"]`);
                if (loaded) this.flash(loaded);
            })
            .catch((error: unknown) => this.log.warn('chat-jump failed', error));
    }

    relocalize(): void {
        this.menu.close();
        this.entries.relocalize();
        this.messageButtons.relocalize();
        this.composer.relocalize();
        this.windows.relocalize();
        this.strip.repaintAll();
    }

    onRegistryChange(listener: () => void): Unsubscribe {
        const off = onRegistryChange(listener);
        this.sectionListeners.add(listener);
        return () => {
            off();
            this.sectionListeners.delete(listener);
        };
    }

    settingsSections(): SettingsSection[] {
        return [...this.sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    }

    /* ---------------------------------------------------------------- internals */

    /** Windows, sections or badges changed: the top-bar badge and the open Maestro menu follow. */
    private windowsChanged(): void {
        const urgent = this.noticeList.some((entry) => entry.urgent && !entry.seen);
        this.entries.setBadge(this.tabs.totalBadge(), urgent);
        this.mainMenu.refresh();
    }

    /** The menu of a message's Maestro button: the speaker's dossier, the mechanics window. */
    private messageMenu(index: number): MenuItem[] {
        const t = this.i18n.t.bind(this.i18n);
        const items: MenuItem[] = [];
        let message: STChatMessage | undefined;
        try {
            message = this.host.ctx().chat?.[index];
        } catch (error) {
            this.log.debug('message menu: no chat', error);
        }
        const name = typeof message?.name === 'string' ? message.name.trim() : '';
        const dossier = this.coreDeps?.modules.api<DossierOpener>('dossier');
        if (message && !message.is_user && !message.is_system && name && dossier) {
            items.push({
                id: 'dossier',
                label: t('ui.mesButton.dossier', { name }),
                icon: 'fa-address-card',
                run: () => this.openDossier(dossier, name),
            });
        }
        if (this.windows.sections('mechanics').length) {
            items.push({
                id: 'mechanics',
                label: t('ui.mesButton.mechanics'),
                icon: 'fa-dice-d20',
                run: () => this.openWindow('mechanics', { params: { messageIndex: index } }),
            });
        }
        if (!items.length) {
            items.push({
                id: 'maestro',
                label: t('ui.mesButton.maestro'),
                icon: 'fa-wand-magic-sparkles',
                run: () => this.openWindow(MAESTRO_WINDOW),
            });
        }
        return items;
    }

    private openDossier(dossier: DossierOpener, name: string): void {
        if (typeof dossier.openByName === 'function') {
            if (dossier.openByName(name)) return;
            this.notice(this.i18n.t('ui.mesButton.noDossier', { name }), { level: 'info', importance: 'urgent' });
        }
        this.openPult('dossier');
    }

    private sectionsChanged(): void {
        for (const listener of [...this.sectionListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('settings section listener failed', error);
            }
        }
    }

    /**
     * A strip item's window section: that window when windows exist (plan-2 §10); without windows, or without a window
     * id (the item only knows the tab), the pult tab — which opens the tab's own window once windows exist.
     */
    private openTarget(target: NonNullable<StripItem['open']>): void {
        const openWindow = (this as Ui).openWindow;
        if (typeof openWindow === 'function' && target.window) {
            openWindow.call(this, target.window, {
                ...(target.tab ? { tab: target.tab } : {}),
                ...(target.params ? { params: target.params } : {}),
            });
            return;
        }
        this.openPult(target.tab);
    }

    private listen(event: string, handler: (...args: unknown[]) => unknown): void {
        try {
            this.unsubscribers.push(this.host.events.on(event, handler));
        } catch (error) {
            this.log.debug(`ui: cannot listen to ${event}`, error);
        }
    }

    private addNotice(entry: NoticeEntry): NoticeEntry {
        this.noticeList.push(entry);
        if (this.noticeList.length > MAX_NOTICES) {
            for (const dropped of this.noticeList.splice(0, this.noticeList.length - MAX_NOTICES)) {
                this.toasts.delete(dropped.id);
                if (dropped.group && this.noticeGroups.get(dropped.group)?.entry === dropped) {
                    this.noticeGroups.delete(dropped.group);
                }
            }
        }
        return entry;
    }

    /** Folds a notice into its group's entry of this turn; null when the group has none yet. */
    private mergeNotice(
        group: string,
        text: string,
        level: NoticeLevel,
        importance: NoticeImportance,
        action: NoticeAction | undefined,
    ): NoticeEntry | null {
        const state = this.noticeGroups.get(group);
        if (!state || state.entry.turn !== this.turn || !this.noticeList.includes(state.entry)) {
            this.noticeGroups.delete(group);
            return null;
        }
        const { entry } = state;
        state.texts.push(text);
        if (action) state.actions.push(action);
        entry.count = state.texts.length;
        entry.text = this.groupText(state);
        entry.at = Date.now();
        if (SEVERITY[level] > SEVERITY[entry.level]) entry.level = level;
        if (RANK[importance] > RANK[entry.importance]) {
            entry.importance = importance;
            entry.urgent = importance === 'urgent';
            if (entry.urgent) entry.seen = false;
        }
        const actions = [...state.actions];
        const first = actions[0];
        entry.action = first
            ? {
                  label: first.label,
                  run: () => {
                      for (const item of actions) {
                          try {
                              item.run();
                          } catch (error) {
                              this.log.error('notice action failed', error);
                          }
                      }
                  },
              }
            : undefined;
        // The newest notice goes last (the Overview lists the newest first).
        const index = this.noticeList.indexOf(entry);
        if (index >= 0) this.noticeList.splice(index, 1);
        this.noticeList.push(entry);
        return entry;
    }

    private groupText(state: NoticeGroup): string {
        const count = state.texts.length;
        try {
            const text = state.groupText?.(count);
            if (text) return text;
        } catch (error) {
            this.log.warn('notice group text failed', error);
        }
        return this.i18n.t('ui.notice.andMore', { text: state.texts[0] ?? '', count: count - 1 });
    }

    private nextTurn(): void {
        this.turn++;
        this.noticeGroups.clear();
    }

    private toast(entry: NoticeEntry): void {
        const notifier = (globalThis as { toastr?: typeof toastr }).toastr;
        if (!notifier) return;
        const previous = this.toasts.get(entry.id);
        if (previous) {
            try {
                (notifier.clear as (toast?: unknown) => void)(previous);
            } catch (error) {
                this.log.debug('toast clear failed', error);
            }
        }
        const title = this.i18n.t('ui.title');
        const action = entry.action;
        const options: Record<string, unknown> = {
            timeOut: entry.level === 'error' ? 15000 : entry.level === 'warn' || action ? 8000 : 5000,
            extendedTimeOut: 5000,
        };
        let message: string | HTMLElement = entry.text;
        if (action) {
            // The action is a real button on the toast: a click elsewhere only opens the Overview, never acts.
            message = el('span', { class: 'maestro-toast' }, [
                el('span', { class: 'maestro-toast-text', text: entry.text }),
                el('button', {
                    class: ['maestro-toast-action', 'menu_button'],
                    text: action.label,
                    attrs: { type: 'button' },
                }),
            ]);
            options.escapeHtml = false;
        }
        options.onclick = (event?: Event) => {
            const target = event?.target;
            const onButton = !!action && target instanceof Element && target.closest('.maestro-toast-action') !== null;
            try {
                if (onButton) action?.run();
                else this.openPult('overview');
            } catch (error) {
                this.log.error('notice action failed', error);
            }
        };
        const show = notifier[TOAST[entry.level]] as (message: unknown, title?: string, options?: unknown) => unknown;
        const handle = show(message, title, options);
        if (handle) this.toasts.set(entry.id, handle);
    }

    private flash(node: HTMLElement): void {
        node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
        node.classList.add('maestro-flash');
        setTimeout(() => node.classList.remove('maestro-flash'), 1600);
    }
}

export function createUi(deps: UiDeps): UiImpl {
    deps.i18n.register(UI_STRINGS);
    return new MaestroUi(deps);
}
