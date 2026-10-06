// Maestro's UI shell: pult (tabs registry), entry points, notices, confirmations, message badges, styles,
// slash commands, health checks and the first-run wizard. Core views are registered by app.ts after mount().
import type {
    HealthCheck,
    Host,
    I18n,
    Logger,
    PultTab,
    SettingsSection,
    SettingsService,
    SlashCommandSpec,
    Ui,
    Unsubscribe,
    WizardStep,
} from '../shared/contracts';
import { el, prefersReducedMotion, setButtonErrorHandler } from './components/dom';
import { EntryPoints } from './views/entry-points';
import { healthTab } from './views/health';
import { inboxTab } from './views/inbox';
import { journalTab } from './views/journal';
import { MessageBadges } from './views/message-badges';
import { overviewTab } from './views/overview';
import { Pult } from './views/pult';
import { onRegistryChange } from './views/registries';
import { settingsTab } from './views/settings';
import { SlashCommands } from './views/slash-commands';
import { UI_STRINGS } from './views/strings';
import { tasksTab } from './views/tasks';
import type { CoreViewDeps, NoticeEntry, NoticeLevel, Shell } from './views/types';
import { Wizard } from './views/wizard';

export { registerProfileTask, registerSettingsAction } from './views/registries';
export type { SettingsAction } from './views/registries';
export type { CoreViewDeps } from './views/types';

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
    /** Opens the first-run wizard if it has not been completed (also runs by itself after APP_READY). */
    runFirstRunWizardIfNeeded(): boolean;
}

const MAX_NOTICES = 50;
/** Lets modules register their wizard steps (modules start after mount) before the wizard opens. */
const WIZARD_DELAY_MS = 1500;

const TOAST: Record<NoticeLevel, 'info' | 'warning' | 'error'> = { info: 'info', warn: 'warning', error: 'error' };

class MaestroUi implements UiImpl, Shell {
    readonly host: Host;
    readonly log: Logger;
    readonly i18n: I18n;
    private readonly settings: SettingsService;
    private readonly pult: Pult;
    private readonly wizard: Wizard;
    private readonly entries: EntryPoints;
    private readonly badges: MessageBadges;
    private readonly slash: SlashCommands;
    private readonly checks = new Map<string, HealthCheck>();
    private readonly sections = new Map<string, SettingsSection>();
    private readonly sectionListeners = new Set<() => void>();
    private readonly styles = new Map<string, HTMLStyleElement>();
    private readonly noticeList: NoticeEntry[] = [];
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
        this.pult = new Pult({
            host: this.host,
            i18n: this.i18n,
            log: this.log,
            onBadgesChanged: () => this.updateBadges(),
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
        this.entries = new EntryPoints({ i18n: this.i18n, log: this.log, open: () => this.openPult() });
        this.badges = new MessageBadges(this.host, this.log);
        this.slash = new SlashCommands(this.host, this.i18n, this.log);
        setButtonErrorHandler((error) => {
            this.log.error('action failed', error);
            this.notice(
                this.i18n.t('ui.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
                { level: 'error' },
            );
        });
    }

    /* ---------------------------------------------------------------- lifecycle */

    mount(): void {
        if (this.mounted || this.disposed) return;
        this.mounted = true;
        this.entries.mount();
        this.updateBadges();
        this.listen('APP_READY', () => {
            // ST builds some containers late; and APP_READY auto-fires for late listeners (lib/eventemitter.js).
            this.entries.mount();
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
        const jobs = deps.jobs;
        if (jobs) {
            this.entries.setJobs(jobs.list());
            this.coreTabs.push(
                jobs.on(() => this.entries.setJobs(jobs.list())),
                () => this.entries.setJobs([]),
            );
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
        this.pult.dispose();
        this.entries.dispose();
        this.badges.dispose();
        this.slash.dispose();
        for (const node of this.styles.values()) node.remove();
        this.styles.clear();
        this.checks.clear();
        this.sections.clear();
        this.sectionListeners.clear();
        this.noticeList.length = 0;
    }

    /* ---------------------------------------------------------------- Ui contract */

    addTab(tab: PultTab): Unsubscribe {
        return this.pult.add(tab);
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

    openPult(tabId?: string): void {
        if (this.disposed) return;
        this.pult.open(tabId);
    }

    closePult(): void {
        this.pult.close();
    }

    refresh(): void {
        this.updateBadges();
        this.pult.rerender();
    }

    notice(
        text: string,
        options: { urgent?: boolean; level?: NoticeLevel; action?: { label: string; run: () => void } } = {},
    ): void {
        const level = options.level ?? 'info';
        const urgent = options.urgent === true;
        const entry: NoticeEntry = {
            id: this.nextNotice++,
            at: Date.now(),
            text,
            level,
            urgent,
            action: options.action,
            seen: !urgent,
        };
        this.noticeList.push(entry);
        if (this.noticeList.length > MAX_NOTICES) this.noticeList.splice(0, this.noticeList.length - MAX_NOTICES);
        if (level === 'error') this.log.warn('notice:', text);
        else this.log.info('notice:', text);
        if (urgent) this.toast(entry);
        this.updateBadges();
        if (this.pult.activeTab() === 'overview') this.pult.rerender();
    }

    async confirm(title: string, body: string | HTMLElement): Promise<boolean> {
        try {
            const c = this.host.ctx();
            const content = el('div', { class: 'maestro-confirm' }, [
                el('h3', { class: 'maestro-confirm-title', text: title }),
                typeof body === 'string' ? el('div', { class: 'maestro-confirm-body', text: body }) : body,
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

    messageBadge(
        messageIndex: number,
        badge: { id: string; text: string; action?: { label: string; run: () => void } },
    ): Unsubscribe {
        if (this.disposed) return () => {};
        return this.badges.add(messageIndex, badge);
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
        this.pult.updateBadges();
        const urgent = this.noticeList.some((entry) => entry.urgent && !entry.seen);
        this.entries.setBadge(this.pult.totalBadge(), urgent);
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
        this.pult.close();
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
        this.entries.relocalize();
        this.pult.relocalize();
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

    private sectionsChanged(): void {
        for (const listener of [...this.sectionListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('settings section listener failed', error);
            }
        }
    }

    private listen(event: string, handler: (...args: unknown[]) => unknown): void {
        try {
            this.unsubscribers.push(this.host.events.on(event, handler));
        } catch (error) {
            this.log.debug(`ui: cannot listen to ${event}`, error);
        }
    }

    private toast(entry: NoticeEntry): void {
        const notifier = (globalThis as { toastr?: typeof toastr }).toastr;
        if (!notifier) return;
        const title = this.i18n.t('ui.title');
        const action = entry.action;
        const text = action ? `${entry.text} ${this.i18n.t('ui.notice.tapTo', { label: action.label })}` : entry.text;
        const options: Record<string, unknown> = {
            timeOut: entry.level === 'error' ? 15000 : 8000,
            extendedTimeOut: 5000,
        };
        if (action) {
            options.onclick = () => {
                try {
                    action.run();
                } catch (error) {
                    this.log.error('notice action failed', error);
                }
            };
        } else {
            options.onclick = () => this.openPult('overview');
        }
        notifier[TOAST[entry.level]](text, title, options);
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
