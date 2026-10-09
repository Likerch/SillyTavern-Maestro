// The Maestro menu (plan-2 §10 п.3): what the top-bar icon, the wand item and `/maestro` open. Windows with their
// badges (open ones marked), the studios as launchers, the jobs the user started (progress; a click opens the job's
// own view), the quick actions of the button at the message box (M40) and «Настройки». The top bar gets no icons of
// its own (plan-2 В18).
import type { I18n, UserJobs } from '../../shared/contracts';
import { jobStatus } from '../views/jobs';
import { STUDIO_WINDOWS } from './builtin';
import type { WindowManager } from './manager';
import type { FloatingMenu, MenuGroup, MenuItem } from './menu';

export interface MainMenuDeps {
    i18n: I18n;
    windows: WindowManager;
    menu: FloatingMenu;
    jobs(): UserJobs | undefined;
    /** More groups before «Настройки» (the quick actions of the button at the message box). */
    extra?(): MenuGroup[];
}

export class MainMenu {
    /** The node the menu was last opened from (the shared FloatingMenu also serves the message buttons). */
    private anchor: HTMLElement | null = null;

    constructor(private readonly deps: MainMenuDeps) {}

    /** Opens under the anchor; a second click on the same anchor closes it. */
    toggle(anchor: HTMLElement): void {
        const { menu } = this.deps;
        if (menu.isOpen() && menu.anchorNode() === anchor) {
            menu.close();
            return;
        }
        this.open(anchor);
    }

    open(anchor: HTMLElement): void {
        this.anchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');
        this.deps.menu.open(anchor, this.groups(), {
            label: this.deps.i18n.t('ui.menu.label'),
            className: 'maestro-main-menu',
            backLabel: this.deps.i18n.t('ui.menu.back'),
            onClose: () => anchor.setAttribute('aria-expanded', 'false'),
        });
    }

    isOpen(): boolean {
        return this.anchor !== null && this.deps.menu.isOpen() && this.deps.menu.anchorNode() === this.anchor;
    }

    /** Badges, open windows or jobs changed: the open menu follows. */
    refresh(): void {
        if (this.isOpen()) this.deps.menu.update(this.groups());
    }

    groups(): MenuGroup[] {
        const t = this.deps.i18n.t.bind(this.deps.i18n);
        const { windows } = this.deps;
        const list = windows.list();
        const windowItems: MenuItem[] = list
            .filter(
                (info) =>
                    (!info.hidden && info.sections !== 0) ||
                    (info.hidden && info.open && !STUDIO_WINDOWS.includes(info.id)),
            )
            .map((info) => ({
                id: `window:${info.id}`,
                label: info.title,
                icon: info.icon,
                badge: info.badge,
                active: info.open,
                run: () => windows.open(info.id),
            }));
        const studioItems: MenuItem[] = list
            .filter((info) => STUDIO_WINDOWS.includes(info.id))
            .map((info) => ({
                id: `window:${info.id}`,
                label: info.title,
                icon: info.icon,
                active: info.open,
                run: () => windows.open(info.id),
            }));
        const jobs = this.deps.jobs();
        const jobItems: MenuItem[] = (jobs?.list() ?? [])
            .filter((job) => job.state === 'active')
            .map((job) => ({
                id: `job:${job.key}`,
                label: job.title,
                icon: 'fa-spinner',
                hint: jobStatus(job, this.deps.i18n),
                progress: job.phase === 'queued' ? undefined : { done: job.done, total: job.total },
                run: () => {
                    if (!job.openable || !jobs?.open(job.key)) windows.openTab('tasks');
                },
            }));
        return [
            { label: t('ui.menu.windows'), items: windowItems },
            { label: t('ui.menu.studios'), items: studioItems },
            { label: t('ui.menu.jobs'), items: jobItems },
            ...(this.deps.extra?.() ?? []),
            {
                items: [
                    {
                        id: 'settings',
                        label: t('ui.menu.settings'),
                        icon: 'fa-gear',
                        run: () => windows.openTab('settings'),
                    },
                ],
            },
        ];
    }
}
