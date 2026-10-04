// The Pult: one large ST Popup with a vertical tab list (desktop) or a full-screen view with a tab picker
// (phones, ≤1000px — ST's breakpoint, see style.css). Tabs render lazily: only the active tab is in the DOM,
// and switching tabs disposes the previous render.
import type { Host, I18n, Logger, PultTab, Unsubscribe } from '../../shared/contracts';
import { emptyState } from '../components/card';
import { button, clear, el, icon, prefersReducedMotion } from '../components/dom';
import { tabs } from '../components/tabs';
import type { TabsHandle } from '../components/tabs';

interface PopupHandle {
    show(): Promise<unknown>;
    completeCancelled(): Promise<unknown>;
    dlg: HTMLDialogElement;
}

export interface PultDeps {
    host: Host;
    i18n: I18n;
    log: Logger;
    /** Tabs or badges changed (the top-bar badge follows). */
    onBadgesChanged(): void;
}

export class Pult {
    private readonly registry = new Map<string, PultTab>();
    private popup: PopupHandle | null = null;
    private nav: TabsHandle | null = null;
    private body: HTMLElement | null = null;
    private chrome: { title: HTMLElement; close: HTMLButtonElement } | null = null;
    private activeId: string | null = null;
    private lastTab: string | null = null;
    private cleanup: (() => void) | null = null;

    constructor(private readonly deps: PultDeps) {}

    add(tab: PultTab): Unsubscribe {
        if (this.registry.has(tab.id)) this.deps.log.warn(`pult tab "${tab.id}" replaced`);
        this.registry.set(tab.id, tab);
        this.syncTabs();
        if (this.isOpen() && this.activeId === tab.id) this.rerender();
        if (this.isOpen() && this.activeId === null) this.select(tab.id);
        this.deps.onBadgesChanged();
        return () => {
            if (this.registry.get(tab.id) !== tab) return;
            this.registry.delete(tab.id);
            if (this.activeId === tab.id) {
                this.unmountActive();
                this.activeId = null;
            }
            this.syncTabs();
            if (this.isOpen() && this.activeId === null) {
                const first = this.tabs()[0];
                if (first) this.select(first.id);
                else this.renderEmpty();
            }
            this.deps.onBadgesChanged();
        };
    }

    /** Registered tabs sorted by order (then id, for a stable order). */
    tabs(): PultTab[] {
        return [...this.registry.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    }

    isOpen(): boolean {
        return this.popup !== null;
    }

    activeTab(): string | null {
        return this.activeId;
    }

    open(tabId?: string): void {
        const target = this.pick(tabId);
        if (this.popup) {
            if (target) this.select(target);
            return;
        }
        const c = this.deps.host.ctx();
        if (typeof c.Popup !== 'function') {
            this.deps.log.error('ST Popup is not available; cannot open the pult');
            return;
        }
        const root = this.buildChrome();
        const popup = new c.Popup(root, c.POPUP_TYPE.DISPLAY, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: false,
            animation: prefersReducedMotion() ? 'none' : 'fast',
        });
        popup.dlg.classList.add('maestro-pult-dialog');
        this.popup = popup;
        void popup.show().then(
            () => this.handleClosed(popup),
            () => this.handleClosed(popup),
        );
        if (target) this.select(target);
        else this.renderEmpty();
    }

    close(): void {
        const popup = this.popup;
        if (!popup) return;
        this.handleClosed(popup);
        void popup.completeCancelled().catch((error: unknown) => this.deps.log.debug('pult close', error));
    }

    select(id: string): void {
        if (!this.registry.has(id) || !this.popup) return;
        this.unmountActive();
        this.activeId = id;
        this.lastTab = id;
        this.nav?.setActive(id);
        this.renderActive();
    }

    /** Re-renders the active tab unless the user is typing in it (a refresh must not eat input). */
    rerender(): void {
        if (!this.popup || !this.activeId || !this.body) return;
        const focused = document.activeElement;
        if (
            focused instanceof HTMLElement &&
            this.body.contains(focused) &&
            focused.matches('input:not([type=checkbox]), textarea')
        )
            return;
        this.unmountActive();
        this.renderActive();
    }

    updateBadges(): void {
        if (!this.nav) return;
        for (const tab of this.registry.values()) this.nav.setBadge(tab.id, this.badgeOf(tab));
    }

    totalBadge(): number {
        let total = 0;
        for (const tab of this.registry.values()) total += this.badgeOf(tab);
        return total;
    }

    /** Language changed: rebuild tab titles and the active view. */
    relocalize(): void {
        if (!this.popup || !this.chrome) return;
        this.chrome.title.textContent = this.deps.i18n.t('ui.title');
        this.chrome.close.title = this.deps.i18n.t('ui.pult.close');
        this.chrome.close.setAttribute('aria-label', this.deps.i18n.t('ui.pult.close'));
        this.syncTabs();
        this.rerender();
    }

    dispose(): void {
        this.close();
        this.registry.clear();
    }

    private pick(tabId?: string): string | null {
        if (tabId && this.registry.has(tabId)) return tabId;
        if (tabId) this.deps.log.warn(`unknown pult tab "${tabId}"`);
        if (this.activeId && this.registry.has(this.activeId)) return this.activeId;
        if (this.lastTab && this.registry.has(this.lastTab)) return this.lastTab;
        return this.tabs()[0]?.id ?? null;
    }

    private badgeOf(tab: PultTab): number {
        if (!tab.badge) return 0;
        try {
            const value = tab.badge();
            return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
        } catch (error) {
            this.deps.log.warn(`badge of tab "${tab.id}" failed`, error);
            return 0;
        }
    }

    private buildChrome(): HTMLElement {
        const t = this.deps.i18n.t.bind(this.deps.i18n);
        this.nav = tabs({ items: [], label: t('ui.pult.tabs'), onSelect: (id) => this.select(id) });
        this.body = el('div', { class: 'maestro-pult-body', attrs: { role: 'tabpanel', tabindex: '-1' } });
        const title = el('h3', { class: 'maestro-pult-title', text: t('ui.title') });
        const close = button({
            icon: 'fa-xmark',
            title: t('ui.pult.close'),
            kind: 'ghost',
            className: 'maestro-pult-close',
            onClick: () => this.close(),
        });
        this.chrome = { title, close };
        this.syncTabs();
        return el('div', { class: 'maestro-pult maestro-theme' }, [
            el('div', { class: 'maestro-pult-header' }, [
                el('div', { class: 'maestro-pult-brand' }, [icon('fa-wand-magic-sparkles'), title]),
                this.nav.picker,
                close,
            ]),
            el('div', { class: 'maestro-pult-main' }, [this.nav.list, this.body]),
        ]);
    }

    private syncTabs(): void {
        if (!this.nav) return;
        this.nav.setItems(
            this.tabs().map((tab) => ({
                id: tab.id,
                label: this.deps.i18n.t(tab.titleKey),
                icon: tab.icon,
                badge: this.badgeOf(tab),
            })),
        );
        if (this.activeId) this.nav.setActive(this.activeId);
    }

    private renderActive(): void {
        const body = this.body;
        const tab = this.activeId ? this.registry.get(this.activeId) : undefined;
        if (!body || !tab) return;
        clear(body);
        body.dataset.tab = tab.id;
        body.scrollTop = 0;
        try {
            const result = tab.render(body);
            this.cleanup = typeof result === 'function' ? result : null;
        } catch (error) {
            this.deps.log.error(`render of tab "${tab.id}" failed`, error);
            clear(body);
            body.appendChild(emptyState(this.deps.i18n.t('ui.pult.renderFailed'), 'fa-bug'));
        }
        this.updateBadges();
    }

    private renderEmpty(): void {
        if (!this.body) return;
        clear(this.body);
        this.body.appendChild(emptyState(this.deps.i18n.t('ui.pult.noTabs'), 'fa-wand-magic-sparkles'));
    }

    private unmountActive(): void {
        const cleanup = this.cleanup;
        this.cleanup = null;
        if (cleanup) {
            try {
                cleanup();
            } catch (error) {
                this.deps.log.warn('tab cleanup failed', error);
            }
        }
        if (this.body) clear(this.body);
    }

    private handleClosed(popup: PopupHandle): void {
        if (this.popup !== popup) return;
        this.unmountActive();
        this.popup = null;
        this.nav = null;
        this.body = null;
        this.chrome = null;
        this.activeId = null;
    }
}
