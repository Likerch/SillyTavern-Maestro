// Ways into Maestro (plan §7, plan-2 §10): a top-bar icon with a badge that opens the Maestro menu (windows, jobs,
// settings), the same menu from the wand, and a block in the Extensions panel that opens the «Maestro» window. All
// three are Maestro's own nodes and are removed on dispose. While a job the user started runs, the same top-bar
// icon gets a thin progress ring (CSS only: no extra icons in the top bar, plan-2 В18).
import type { I18n, Logger, UserJobInfo } from '../../shared/contracts';
import { el } from '../components/dom';
import { jobFraction, jobStatus } from './jobs';

const TOP_ID = 'maestro-topbar';
const EXT_ID = 'maestro-ext-settings';
const WAND_ID = 'maestro-wand';
const ICON = 'fa-wand-magic-sparkles';

interface Deps {
    i18n: I18n;
    log: Logger;
    /** Opens (or closes) the Maestro menu under the given node. */
    menu(anchor: HTMLElement): void;
    /** Opens the «Maestro» window. */
    openMain(): void;
}

function activate(node: HTMLElement, run: () => void): void {
    node.addEventListener('click', run);
    node.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        run();
    });
}

export class EntryPoints {
    private top: { root: HTMLElement; toggle: HTMLElement; badge: HTMLElement } | null = null;
    private ext: { root: HTMLElement; title: HTMLElement; text: HTMLElement; open: HTMLElement } | null = null;
    private wand: { root: HTMLElement; label: HTMLElement; item: HTMLElement } | null = null;
    private badge = { count: 0, urgent: false };
    private running: UserJobInfo[] = [];

    constructor(private readonly deps: Deps) {}

    /** Idempotent: mounts whatever is missing (ST builds the wand menu late, so APP_READY calls this again). */
    mount(): void {
        if (!this.top?.root.isConnected) this.mountTop();
        if (!this.ext?.root.isConnected) this.mountExtensions();
        if (!this.wand?.root.isConnected) this.mountWand();
        this.setBadge(this.badge.count, this.badge.urgent);
        this.setJobs(this.running);
    }

    setBadge(count: number, urgent: boolean): void {
        this.badge = { count, urgent };
        if (!this.top) return;
        const { badge } = this.top;
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = count <= 0;
        badge.classList.toggle('maestro-urgent', urgent);
        this.updateTitle();
    }

    /** Jobs the user started: a ring while any runs (its share done when there is one job that counts). */
    setJobs(jobs: readonly UserJobInfo[]): void {
        this.running = jobs.filter((job) => job.state === 'active');
        if (!this.top) return;
        const { root } = this.top;
        const busy = this.running.length > 0;
        const fraction = this.running.length === 1 && this.running[0] ? jobFraction(this.running[0]) : null;
        root.classList.toggle('maestro-topbar-busy', busy);
        root.classList.toggle('maestro-topbar-indeterminate', busy && fraction === null);
        if (busy && fraction !== null)
            root.style.setProperty('--maestro-job-progress', String(Math.max(0.03, fraction)));
        else root.style.removeProperty('--maestro-job-progress');
        this.updateTitle();
    }

    private updateTitle(): void {
        if (!this.top) return;
        const t = this.deps.i18n.t.bind(this.deps.i18n);
        const count = this.badge.count;
        const parts = [count > 0 ? t('ui.entry.topTitleCount', { count }) : t('ui.entry.topTitle')];
        const [first] = this.running;
        if (this.running.length > 1) parts.push(t('ui.entry.topTitleJobs', { count: this.running.length }));
        else if (first)
            parts.push(t('ui.entry.topTitleJob', { title: first.title, status: jobStatus(first, this.deps.i18n) }));
        const label = parts.join(' · ');
        this.top.toggle.title = label;
        this.top.toggle.setAttribute('aria-label', label);
    }

    /** The top-bar icon (the menu opens under it), if it is on the page. */
    topAnchor(): HTMLElement | null {
        return this.top?.toggle.isConnected ? this.top.toggle : null;
    }

    relocalize(): void {
        const t = this.deps.i18n.t.bind(this.deps.i18n);
        if (this.ext) {
            this.ext.title.textContent = t('ui.title');
            this.ext.text.textContent = t('ui.entry.description');
            this.ext.open.textContent = t('ui.entry.open');
        }
        if (this.wand) {
            this.wand.label.textContent = t('ui.title');
            this.wand.item.title = t('ui.entry.wandTitle');
        }
        this.setBadge(this.badge.count, this.badge.urgent);
    }

    dispose(): void {
        this.top?.root.remove();
        this.ext?.root.remove();
        this.wand?.root.remove();
        this.top = null;
        this.ext = null;
        this.wand = null;
    }

    private mountTop(): void {
        const holder = document.querySelector('#top-settings-holder');
        if (!holder) {
            this.deps.log.debug('top bar not found');
            return;
        }
        document.getElementById(TOP_ID)?.remove();
        const badge = el('span', { class: 'maestro-topbar-badge', attrs: { 'aria-hidden': 'true' } });
        badge.hidden = true;
        const toggle = el(
            'div',
            {
                class: 'maestro-topbar-toggle',
                attrs: { role: 'button', tabindex: '0', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
            },
            [el('div', { class: ['drawer-icon', 'fa-solid', ICON, 'fa-fw', 'closedIcon'] }), badge],
        );
        activate(toggle, () => this.deps.menu(toggle));
        const root = el('div', { class: 'drawer maestro-topbar', attrs: { id: TOP_ID } }, [toggle]);
        const extensions = document.getElementById('extensions-settings-button');
        if (extensions?.parentElement === holder) extensions.after(root);
        else holder.appendChild(root);
        this.top = { root, toggle, badge };
    }

    private mountExtensions(): void {
        const container =
            document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
        if (!container) {
            this.deps.log.debug('extensions panel not found');
            return;
        }
        document.getElementById(EXT_ID)?.remove();
        const t = this.deps.i18n.t.bind(this.deps.i18n);
        const title = el('b', { text: t('ui.title') });
        const text = el('div', { class: 'maestro-ext-text', text: t('ui.entry.description') });
        const open = el('div', {
            class: 'menu_button maestro-ext-open',
            text: t('ui.entry.open'),
            attrs: { role: 'button', tabindex: '0' },
        });
        activate(open, () => this.deps.openMain());
        // ST toggles .inline-drawer through a delegated document listener (script.js), so no handler is needed here.
        const root = el('div', { class: 'extension_container maestro-ext', attrs: { id: EXT_ID } }, [
            el('div', { class: 'inline-drawer' }, [
                el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [
                    title,
                    el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
                ]),
                el('div', { class: 'inline-drawer-content maestro-ext-content' }, [text, open]),
            ]),
        ]);
        container.appendChild(root);
        this.ext = { root, title, text, open };
    }

    private mountWand(): void {
        const menu = document.querySelector('#extensionsMenu');
        if (!menu) {
            this.deps.log.debug('wand menu not found');
            return;
        }
        document.getElementById(WAND_ID)?.remove();
        const t = this.deps.i18n.t.bind(this.deps.i18n);
        const label = el('span', { text: t('ui.title') });
        const item = el(
            'div',
            {
                class: 'list-group-item flex-container flexGap5 interactable',
                title: t('ui.entry.wandTitle'),
                attrs: { role: 'button', tabindex: '0', 'aria-haspopup': 'menu' },
            },
            [el('div', { class: ['fa-solid', ICON, 'extensionsMenuExtensionButton'] }), label],
        );
        activate(item, () => this.deps.menu(item));
        const root = el('div', { class: 'extension_container maestro-wand', attrs: { id: WAND_ID } }, [item]);
        menu.appendChild(root);
        this.wand = { root, label, item };
    }
}
