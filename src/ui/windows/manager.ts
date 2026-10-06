// Maestro's windows (plan-2 §10) instead of the modal pult. Non-modal: the chat stays usable. A window is a side
// panel (left or right, next to or over the edge of ST's chat column, like ST's own drawers; several on one side
// stack), or a floating window (dragged by its header, resized by the corner grip, brought forward on a click,
// collapsed to its title bar). Detach ⇄ attach in the header. Phones and narrow windows (≤1000px, ST's breakpoint):
// a full-screen sheet over the chat with a switcher of the open windows, one visible at a time.
//
// A window either shows sections — the pult tabs of its groups, rendered lazily (only the active section of a
// visible window is in the DOM; hiding, collapsing, switching and closing run the section's cleanup, so the dock's
// borrowed nodes go home) — or a body of its own (`spec.render`, the studios), kept while the window is open.
// Everything is Maestro's own body-level DOM, removed on dispose; the layout is remembered per device (layout.ts).
import type {
    I18n,
    Logger,
    MaestroWindowSpec,
    OpenWindowOptions,
    PultTab,
    Unsubscribe,
    WindowContext,
    WindowDock,
} from '../../shared/contracts';
import { MODULE_SETTINGS_CLASS, emptyState } from '../components/card';
import { button, clear, el, icon } from '../components/dom';
import {
    MIN_FLOAT_HEIGHT,
    MIN_FLOAT_WIDTH,
    clampFloat,
    clampSideWidth,
    defaultFloat,
    defaultSideWidth,
    isSheetViewport,
    loadLayout,
    saveLayout,
    viewport,
} from './layout';
import type { LayoutState, Side, WindowPlace } from './layout';
import { MAESTRO_WINDOW, sectionsOf, sortSpecs, windowForTab } from './sections';
import type { TabRegistry } from './sections';

/** z-index of floating windows (side panels: 2900 in style.css; ST's top bar and its drawers: 3005). */
const FLOAT_Z = 2910;
const MAX_Z_STEPS = 60;
const SIDES: readonly Side[] = ['left', 'right'];

export interface WindowManagerDeps {
    i18n: I18n;
    log: Logger;
    tabs: TabRegistry;
    /** Windows opened or closed, sections or badges changed: the menu and the top-bar badge follow. */
    onChange(): void;
}

/** What the Maestro menu and `/maestro` know about a window. */
export interface WindowInfo {
    id: string;
    title: string;
    icon: string;
    order: number;
    hidden: boolean;
    open: boolean;
    badge: number;
    /** Sections of a section window (0: nothing to show yet); -1 for a window with a body of its own. */
    sections: number;
}

interface Win {
    spec: MaestroWindowSpec;
    root: HTMLElement;
    title: HTMLElement;
    controls: Record<'gear' | 'swap' | 'detach' | 'attach' | 'collapse' | 'close', HTMLButtonElement>;
    switcher: HTMLElement;
    strip: HTMLElement;
    body: HTMLElement;
    grip: HTMLElement;
    place: WindowPlace;
    /** Active section (section windows). */
    activeTab: string | null;
    /** A section asked for (or remembered) that is not registered yet: it takes over when it arrives. */
    wanted: string | null;
    /** The tab object whose render the body holds (a replaced tab re-renders); null: empty state. */
    rendered: PultTab | null;
    mounted: boolean;
    cleanup: Unsubscribe | null;
    params: Record<string, unknown>;
    paramListeners: Set<(params: Record<string, unknown>) => void>;
    titleText: string | null;
    settingsOn: boolean;
    closing: boolean;
}

type ControlKey = keyof Win['controls'];

function isThenable(value: unknown): value is PromiseLike<boolean> {
    return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function setIcon(node: HTMLElement, name: string): void {
    const glyph = node.querySelector('i');
    if (!glyph) return;
    glyph.className = '';
    glyph.classList.add('fa-solid', name, 'fa-fw');
}

export class WindowManager {
    private readonly specs = new Map<string, MaestroWindowSpec>();
    private readonly wins = new Map<string, Win>();
    private readonly layout: LayoutState = loadLayout();
    /** Open windows, most recently in front first. */
    private recent: string[] = [];
    private root: HTMLElement | null = null;
    private sides: Record<Side, HTMLElement> | null = null;
    private rootOffs: (() => void)[] = [];
    private sheet = false;
    private zCounter = 0;
    private gesture: (() => void) | null = null;
    private restored = false;
    private disposed = false;
    private readonly tabsOff: Unsubscribe;

    constructor(private readonly deps: WindowManagerDeps) {
        this.tabsOff = deps.tabs.onChange(() => this.tabsChanged());
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.deps.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- registry */

    add(spec: MaestroWindowSpec): Unsubscribe {
        if (this.disposed) return () => {};
        if (this.specs.has(spec.id)) this.deps.log.warn(`window "${spec.id}" replaced`);
        this.specs.set(spec.id, spec);
        const open = this.wins.get(spec.id);
        if (open) {
            // Same id again (a module restarted): rebuild the body with the new spec.
            this.destroy(open, false);
            this.show(spec.id, {}, true);
        }
        this.tabsChanged();
        return () => {
            if (this.specs.get(spec.id) !== spec) return;
            this.specs.delete(spec.id);
            const win = this.wins.get(spec.id);
            if (win) this.destroy(win, false);
            this.tabsChanged();
        };
    }

    has(id: string): boolean {
        return this.specs.has(id);
    }

    isOpen(id: string): boolean {
        return this.wins.has(id);
    }

    /** The window in front (phones: the visible one). */
    front(): string | null {
        return this.recent.find((id) => this.wins.has(id)) ?? null;
    }

    isSheet(): boolean {
        return this.sheet;
    }

    windowOfTab(tabId: string): string | undefined {
        return windowForTab([...this.specs.values()], this.deps.tabs.get(tabId) ?? { id: tabId });
    }

    /** The active section of an open window. */
    activeTab(id: string): string | null {
        return this.wins.get(id)?.activeTab ?? null;
    }

    sections(id: string): PultTab[] {
        const spec = this.specs.get(id);
        return spec ? sectionsOf([...this.specs.values()], spec, this.deps.tabs.all()) : [];
    }

    list(): WindowInfo[] {
        return sortSpecs(this.specs.values()).map((spec) => ({
            id: spec.id,
            title: this.t(spec.titleKey),
            icon: spec.icon,
            order: spec.order,
            hidden: spec.hidden === true,
            open: this.wins.has(spec.id),
            badge: this.badgeOf(spec),
            sections: spec.render ? -1 : this.sections(spec.id).length,
        }));
    }

    badgeOf(spec: MaestroWindowSpec): number {
        if (spec.badge) {
            try {
                const value = spec.badge();
                return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
            } catch (error) {
                this.deps.log.warn(`badge of window "${spec.id}" failed`, error);
                return 0;
            }
        }
        if (spec.render) return 0;
        return this.sections(spec.id).reduce((sum, tab) => sum + this.deps.tabs.badgeOf(tab), 0);
    }

    /* ---------------------------------------------------------------- open, close */

    open(id: string, options: OpenWindowOptions = {}): void {
        this.show(id, options, false);
    }

    /** Opens the window that shows a pult tab, on that section (`openPult` of old). */
    openTab(tabId?: string): void {
        if (!tabId) {
            this.open(MAESTRO_WINDOW);
            return;
        }
        const target = this.windowOfTab(tabId);
        if (!target) this.deps.log.warn(`unknown pult tab "${tabId}"`);
        this.open(target ?? MAESTRO_WINDOW, { tab: tabId });
    }

    /** Closes a window unless its guard (unsaved edits) keeps it open; resolves to whether it closed. */
    requestClose(id: string): Promise<boolean> {
        const win = this.wins.get(id);
        if (!win) return Promise.resolve(true);
        if (win.closing) return Promise.resolve(false);
        let verdict: boolean | PromiseLike<boolean> = true;
        try {
            verdict = win.spec.canClose?.() ?? true;
        } catch (error) {
            this.deps.log.warn(`close guard of window "${id}" failed`, error);
        }
        if (isThenable(verdict)) {
            win.closing = true;
            return Promise.resolve(verdict).then(
                (ok) => {
                    win.closing = false;
                    if (ok === false || this.wins.get(id) !== win) return false;
                    this.finishClose(win);
                    return true;
                },
                (error: unknown) => {
                    win.closing = false;
                    this.deps.log.warn(`close guard of window "${id}" failed`, error);
                    return false;
                },
            );
        }
        if (verdict === false) return Promise.resolve(false);
        this.finishClose(win);
        return Promise.resolve(true);
    }

    close(id: string): void {
        void this.requestClose(id);
    }

    /**
     * Makes room for the chat (`closePult()` of old, called before jumping to a message or opening ST's own UI): on a
     * phone the visible window closes; on a desktop windows do not cover the chat and stay.
     */
    yieldToChat(): void {
        if (!this.sheet) return;
        const front = this.front();
        if (front) this.close(front);
    }

    /** Re-opens the windows that were open on this device (once per page, after the modules started). */
    restore(): void {
        if (this.restored || this.disposed) return;
        this.restored = true;
        const ids = Object.entries(this.layout.windows)
            .filter(([id, place]) => place.open && this.specs.has(id) && this.specs.get(id)?.hidden !== true)
            .map(([id]) => id);
        const front = this.layout.front;
        const ordered = front && ids.includes(front) ? [...ids.filter((id) => id !== front), front] : ids;
        for (const id of ordered) this.show(id, {}, true);
    }

    /* ---------------------------------------------------------------- refresh */

    /** Badges, then the visible sections re-render (not under the user's cursor in a text field). */
    refresh(): void {
        for (const win of this.wins.values()) if (!win.spec.render) this.rerender(win);
        this.updateBadges();
    }

    rerenderTab(tabId: string): void {
        for (const win of this.wins.values()) if (win.activeTab === tabId) this.rerender(win);
    }

    updateBadges(): void {
        for (const win of this.wins.values()) {
            this.updateStripBadges(win);
            this.syncSwitcher(win);
        }
        this.deps.onChange();
    }

    relocalize(): void {
        for (const win of this.wins.values()) {
            win.title.textContent = win.titleText ?? this.t(win.spec.titleKey);
            for (const node of Object.values(win.controls)) {
                const key = node.dataset.titleKey;
                if (!key) continue;
                node.title = this.t(key);
                node.setAttribute('aria-label', node.title);
            }
            this.syncControls(win);
            this.syncStrip(win);
            this.syncSwitcher(win);
            win.strip.setAttribute('aria-label', this.t('ui.window.sections'));
            if (!win.spec.render) this.rerender(win);
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.tabsOff();
        for (const win of [...this.wins.values()]) this.destroy(win, false);
        this.removeRoot();
        this.specs.clear();
    }

    /* ---------------------------------------------------------------- internals: open/close */

    private show(id: string, options: OpenWindowOptions, restoring: boolean): void {
        if (this.disposed) return;
        let spec = this.specs.get(id);
        if (!spec) {
            this.deps.log.warn(`unknown window "${id}"`);
            spec = this.specs.get(MAESTRO_WINDOW);
            if (!spec) return;
        }
        let win = this.wins.get(spec.id);
        if (!win) {
            win = this.create(spec, options);
        } else {
            if (options.dock && options.dock !== win.place.dock) this.setDock(win, options.dock);
            if (options.params) {
                win.params = { ...options.params };
                this.emitParams(win);
            }
            if (!spec.render && options.tab) this.selectRequested(win, options.tab);
        }
        // Opening a window means seeing it; only a reload brings it back collapsed.
        if (!restoring) win.place.collapsed = false;
        win.place.open = true;
        this.toFront(win);
        this.layoutAll();
        this.persist();
        this.deps.onChange();
    }

    private create(spec: MaestroWindowSpec, options: OpenWindowOptions): Win {
        const saved = this.layout.windows[spec.id];
        const dock: WindowDock = options.dock ?? saved?.dock ?? spec.defaultDock ?? 'right';
        const place: WindowPlace = {
            open: true,
            dock,
            side: dock === 'left' ? 'left' : dock === 'right' ? 'right' : (saved?.side ?? 'right'),
            x: saved?.x,
            y: saved?.y,
            width: saved?.width,
            height: saved?.height,
            collapsed: saved?.collapsed === true,
            tab: saved?.tab,
        };
        const win = this.build(spec, place);
        win.params = { ...(options.params ?? {}) };
        this.wins.set(spec.id, win);
        if (place.dock === 'float') this.ensureFloatRect(win);
        this.ensureRoot();
        if (spec.render) {
            this.placeWindow(win);
            this.mountCustom(win);
        } else {
            const ids = this.sections(spec.id).map((tab) => tab.id);
            const asked = options.tab ?? saved?.tab ?? null;
            win.activeTab = asked && ids.includes(asked) ? asked : (ids[0] ?? null);
            win.wanted = asked && !ids.includes(asked) ? asked : null;
            place.tab = win.activeTab ?? place.tab;
            this.syncStrip(win);
        }
        return win;
    }

    private build(spec: MaestroWindowSpec, place: WindowPlace): Win {
        const titleId = `maestro-window-title-${spec.id}`;
        const title = el('h3', {
            class: 'maestro-window-title',
            text: this.t(spec.titleKey),
            attrs: { id: titleId },
        });
        const control = (key: ControlKey, iconName: string, titleKey: string, run: () => void) => {
            const node = button({
                icon: iconName,
                title: this.t(titleKey),
                kind: 'ghost',
                className: `maestro-window-btn maestro-window-${key}`,
                onClick: (event) => {
                    event.stopPropagation();
                    run();
                },
            });
            node.dataset.titleKey = titleKey;
            return node;
        };
        const id = spec.id;
        const winOf = () => this.wins.get(id);
        const controls: Win['controls'] = {
            gear: control('gear', 'fa-gear', 'ui.window.settings', () => {
                const win = winOf();
                if (win) this.toggleSettings(win);
            }),
            swap: control('swap', 'fa-arrow-right-arrow-left', 'ui.window.otherSide', () => {
                const win = winOf();
                if (win) this.setDock(win, win.place.dock === 'left' ? 'right' : 'left', true);
            }),
            detach: control('detach', 'fa-up-right-from-square', 'ui.window.detach', () => {
                const win = winOf();
                if (win) this.setDock(win, 'float', true);
            }),
            attach: control('attach', 'fa-table-columns', 'ui.window.attach', () => {
                const win = winOf();
                if (win) this.setDock(win, win.place.side, true);
            }),
            collapse: control('collapse', 'fa-chevron-up', 'ui.window.collapse', () => {
                const win = winOf();
                if (win) this.toggleCollapsed(win);
            }),
            close: control('close', 'fa-xmark', 'ui.window.close', () => this.close(id)),
        };
        const header = el('div', { class: 'maestro-window-header' }, [
            el('div', { class: 'maestro-window-brand' }, [icon(spec.icon, 'maestro-window-icon'), title]),
            el('div', { class: 'maestro-window-controls' }, Object.values(controls)),
        ]);
        const switcher = el('div', {
            class: 'maestro-window-switcher',
            attrs: { role: 'tablist', 'aria-label': this.t('ui.window.switcher') },
        });
        switcher.hidden = true;
        const strip = el('div', {
            class: 'maestro-window-sections',
            attrs: { role: 'tablist', 'aria-label': this.t('ui.window.sections') },
        });
        strip.hidden = true;
        const body = el('div', {
            class: ['maestro-window-body', spec.render ? 'maestro-window-custom' : null],
            attrs: { role: spec.render ? null : 'tabpanel', tabindex: '-1' },
        });
        const grip = el('div', { class: 'maestro-window-grip', attrs: { 'aria-hidden': 'true' } });
        const root = el(
            'div',
            {
                class: ['maestro-window', spec.render ? 'maestro-window-has-body' : 'maestro-window-has-sections'],
                data: { window: spec.id },
                attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, tabindex: '-1' },
            },
            [header, switcher, strip, body, grip],
        );
        const win: Win = {
            spec,
            root,
            title,
            controls,
            switcher,
            strip,
            body,
            grip,
            place,
            activeTab: null,
            wanted: null,
            rendered: null,
            mounted: false,
            cleanup: null,
            params: {},
            paramListeners: new Set(),
            titleText: null,
            settingsOn: false,
            closing: false,
        };
        header.addEventListener('pointerdown', (event) => this.startDrag(win, event));
        header.addEventListener('dblclick', (event) => {
            if (event.target instanceof Element && event.target.closest('button')) return;
            if (!this.sheet) this.toggleCollapsed(win);
        });
        grip.addEventListener('pointerdown', (event) => this.startResize(win, event));
        return win;
    }

    private finishClose(win: Win): void {
        win.place.open = false;
        this.destroy(win, true);
        this.persist();
        this.deps.onChange();
    }

    /** Takes a window down: the body's cleanup runs while it is still in the document (borrowed nodes go home). */
    private destroy(win: Win, closedByUser: boolean): void {
        const id = win.spec.id;
        if (this.wins.get(id) !== win) return;
        this.release(win);
        win.paramListeners.clear();
        win.root.remove();
        this.wins.delete(id);
        this.recent = this.recent.filter((item) => item !== id);
        if (closedByUser) this.layout.windows[id] = { ...win.place, open: false };
        if (!this.wins.size) this.removeRoot();
        else this.layoutAll();
    }

    /** Runs the body's cleanup and empties it. */
    private release(win: Win): void {
        const cleanup = win.cleanup;
        win.cleanup = null;
        win.mounted = false;
        win.rendered = null;
        if (cleanup) {
            try {
                cleanup();
            } catch (error) {
                this.deps.log.warn(`cleanup of window "${win.spec.id}" failed`, error);
            }
        }
        clear(win.body);
        delete win.body.dataset.tab;
    }

    /* ---------------------------------------------------------------- internals: bodies */

    private mountCustom(win: Win): void {
        const render = win.spec.render;
        if (!render) return;
        const id = win.spec.id;
        const ctx: WindowContext = {
            close: () => this.close(id),
            setTitle: (text) => {
                win.titleText = text || null;
                win.title.textContent = win.titleText ?? this.t(win.spec.titleKey);
            },
            params: () => ({ ...win.params }),
            onParams: (listener) => {
                win.paramListeners.add(listener);
                return () => win.paramListeners.delete(listener);
            },
        };
        win.mounted = true;
        try {
            const result = render(win.body, ctx);
            win.cleanup = typeof result === 'function' ? result : null;
        } catch (error) {
            this.deps.log.error(`render of window "${id}" failed`, error);
            clear(win.body);
            win.body.appendChild(emptyState(this.t('ui.pult.renderFailed'), 'fa-bug'));
        }
    }

    private emitParams(win: Win): void {
        for (const listener of [...win.paramListeners]) {
            try {
                listener({ ...win.params });
            } catch (error) {
                this.deps.log.error(`params listener of window "${win.spec.id}" failed`, error);
            }
        }
    }

    private visible(win: Win): boolean {
        if (!this.wins.has(win.spec.id) || !win.root.isConnected) return false;
        if (this.sheet) return this.front() === win.spec.id;
        return !win.place.collapsed;
    }

    /** Section windows: only the active section of a visible window is rendered. */
    private sync(win: Win): void {
        if (win.spec.render) return;
        const visible = this.visible(win);
        const tab = win.activeTab ? this.deps.tabs.get(win.activeTab) : undefined;
        if (!visible) {
            if (win.mounted) this.release(win);
            return;
        }
        if (win.mounted && win.rendered === (tab ?? null)) return;
        this.release(win);
        this.renderSection(win, tab);
    }

    private renderSection(win: Win, tab: PultTab | undefined): void {
        const body = win.body;
        clear(body);
        win.mounted = true;
        win.rendered = tab ?? null;
        body.scrollTop = 0;
        if (!tab) {
            body.appendChild(emptyState(this.t('ui.pult.noTabs'), 'fa-wand-magic-sparkles'));
            return;
        }
        body.dataset.tab = tab.id;
        try {
            const result = tab.render(body);
            win.cleanup = typeof result === 'function' ? result : null;
        } catch (error) {
            this.deps.log.error(`render of tab "${tab.id}" failed`, error);
            clear(body);
            body.appendChild(emptyState(this.t('ui.pult.renderFailed'), 'fa-bug'));
        }
        this.updateStripBadges(win);
    }

    /** Re-renders the active section unless the user is typing in it (a refresh must not eat input). */
    private rerender(win: Win): void {
        if (win.spec.render || !win.mounted || !this.visible(win)) return;
        const focused = document.activeElement;
        if (
            focused instanceof HTMLElement &&
            win.body.contains(focused) &&
            focused.matches('input:not([type=checkbox]):not([type=radio]), textarea')
        )
            return;
        const tab = win.activeTab ? this.deps.tabs.get(win.activeTab) : undefined;
        this.release(win);
        this.renderSection(win, tab);
    }

    private select(win: Win, tabId: string): void {
        if (!this.sections(win.spec.id).some((tab) => tab.id === tabId)) return;
        win.activeTab = tabId;
        win.place.tab = tabId;
        win.wanted = null;
        this.release(win);
        this.syncStrip(win);
        this.sync(win);
        this.persist();
    }

    /** openWindow(id, { tab }): the section now, or as soon as its module registers it. */
    private selectRequested(win: Win, tabId: string): void {
        if (this.sections(win.spec.id).some((tab) => tab.id === tabId)) {
            this.select(win, tabId);
            return;
        }
        if (this.windowOfTab(tabId) === win.spec.id) win.wanted = tabId;
        else this.deps.log.debug(`tab "${tabId}" is not a section of window "${win.spec.id}"`);
    }

    private tabsChanged(): void {
        if (this.disposed) return;
        for (const win of this.wins.values()) {
            if (win.spec.render) continue;
            const ids = this.sections(win.spec.id).map((tab) => tab.id);
            if (win.wanted && ids.includes(win.wanted)) {
                win.activeTab = win.wanted;
                win.place.tab = win.wanted;
                win.wanted = null;
            }
            if (win.activeTab && !ids.includes(win.activeTab)) {
                this.release(win);
                win.activeTab = null;
            }
            if (!win.activeTab) win.activeTab = ids[0] ?? null;
            this.syncStrip(win);
            this.sync(win);
        }
        this.deps.onChange();
    }

    /* ---------------------------------------------------------------- internals: header, strip, switcher */

    private syncStrip(win: Win): void {
        if (win.spec.render) return;
        const tabs = this.sections(win.spec.id);
        win.strip.hidden = tabs.length <= 1;
        win.strip.replaceChildren(
            ...tabs.map((tab) => {
                const on = tab.id === win.activeTab;
                const node = el(
                    'button',
                    {
                        class: ['maestro-window-section', on ? 'maestro-on' : null],
                        data: { tab: tab.id },
                        attrs: { type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false' },
                    },
                    [
                        icon(tab.icon),
                        el('span', { class: 'maestro-window-section-label', text: this.t(tab.titleKey) }),
                        el('span', { class: 'maestro-window-section-badge' }),
                    ],
                );
                node.addEventListener('click', () => this.select(win, tab.id));
                return node;
            }),
        );
        this.updateStripBadges(win);
        this.syncControls(win);
    }

    private updateStripBadges(win: Win): void {
        for (const node of win.strip.querySelectorAll<HTMLElement>('.maestro-window-section')) {
            const tab = node.dataset.tab ? this.deps.tabs.get(node.dataset.tab) : undefined;
            const badge = node.querySelector<HTMLElement>('.maestro-window-section-badge');
            if (!badge) continue;
            const value = tab ? this.deps.tabs.badgeOf(tab) : 0;
            badge.textContent = value > 99 ? '99+' : String(value);
            badge.hidden = value <= 0;
        }
    }

    /** Phones: chips of the open windows over the visible one (two or more open). */
    private syncSwitcher(win: Win): void {
        const open = sortSpecs([...this.wins.values()].map((item) => item.spec));
        const show = this.sheet && open.length > 1;
        win.switcher.hidden = !show;
        if (!show) {
            win.switcher.replaceChildren();
            return;
        }
        win.switcher.setAttribute('aria-label', this.t('ui.window.switcher'));
        win.switcher.replaceChildren(
            ...open.map((spec) => {
                const on = spec.id === win.spec.id;
                const badge = this.badgeOf(spec);
                const node = el(
                    'button',
                    {
                        class: ['maestro-window-chip', on ? 'maestro-on' : null],
                        data: { window: spec.id },
                        attrs: { type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false' },
                    },
                    [
                        icon(spec.icon),
                        el('span', { class: 'maestro-window-chip-label', text: this.t(spec.titleKey) }),
                        badge > 0 ? el('span', { class: 'maestro-window-section-badge', text: String(badge) }) : null,
                    ],
                );
                node.addEventListener('click', () => this.open(spec.id));
                return node;
            }),
        );
    }

    private syncControls(win: Win): void {
        const { controls, place } = win;
        const floating = place.dock === 'float';
        controls.gear.hidden = !!win.spec.render;
        controls.swap.hidden = this.sheet || floating;
        controls.detach.hidden = this.sheet || floating;
        controls.attach.hidden = this.sheet || !floating;
        controls.collapse.hidden = this.sheet;
        const collapsed = place.collapsed && !this.sheet;
        const key = collapsed ? 'ui.window.expand' : 'ui.window.collapse';
        controls.collapse.dataset.titleKey = key;
        controls.collapse.title = this.t(key);
        controls.collapse.setAttribute('aria-label', controls.collapse.title);
        controls.collapse.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        setIcon(controls.collapse, collapsed ? 'fa-chevron-down' : 'fa-chevron-up');
        controls.swap.dataset.titleKey = place.dock === 'left' ? 'ui.window.toRight' : 'ui.window.toLeft';
        controls.swap.title = this.t(controls.swap.dataset.titleKey);
        controls.swap.setAttribute('aria-label', controls.swap.title);
        controls.gear.setAttribute('aria-pressed', win.settingsOn ? 'true' : 'false');
    }

    /**
     * The gear (plan-2 §10 п.4): a section's own module settings are hidden in a window until the gear shows them;
     * a section without any opens the general settings in the «Maestro» window.
     */
    private toggleSettings(win: Win): void {
        const blocks = [...win.body.querySelectorAll<HTMLElement>(`.${MODULE_SETTINGS_CLASS}`)];
        if (!blocks.length && !win.settingsOn) {
            this.openTab('settings');
            return;
        }
        win.settingsOn = !win.settingsOn;
        win.root.classList.toggle('maestro-window-settings-on', win.settingsOn);
        this.syncControls(win);
        const first = blocks[0];
        if (!win.settingsOn || !first) return;
        if (first instanceof HTMLDetailsElement) first.open = true;
        // Scroll the window body only: scrollIntoView would also scroll ST's page (overflow: hidden scrolls too).
        const offset = first.getBoundingClientRect().top - win.body.getBoundingClientRect().top;
        win.body.scrollTop = Math.max(0, win.body.scrollTop + offset - 8);
    }

    private toggleCollapsed(win: Win): void {
        win.place.collapsed = !win.place.collapsed;
        this.layoutAll();
        this.persist();
    }

    private setDock(win: Win, dock: WindowDock, remember = true): void {
        if (dock !== 'float') win.place.side = dock;
        win.place.dock = dock;
        if (dock === 'float') this.ensureFloatRect(win);
        else win.root.style.zIndex = '';
        this.toFront(win);
        this.layoutAll();
        if (remember) this.persist();
    }

    private ensureFloatRect(win: Win): void {
        const { place, spec } = win;
        if (place.x !== undefined && place.y !== undefined && place.width && place.height) {
            Object.assign(place, clampFloat({ x: place.x, y: place.y, width: place.width, height: place.height }));
            return;
        }
        const floats = [...this.wins.values()].filter((item) => item !== win && item.place.dock === 'float').length;
        Object.assign(place, defaultFloat(spec.defaultWidth, spec.defaultHeight, floats));
    }

    private toFront(win: Win): void {
        const id = win.spec.id;
        this.recent = [id, ...this.recent.filter((item) => item !== id)];
        this.layout.front = id;
        if (win.place.dock === 'float') {
            this.zCounter++;
            if (this.zCounter > MAX_Z_STEPS) this.normalizeZ();
            else win.root.style.zIndex = String(FLOAT_Z + this.zCounter);
        }
        for (const item of this.wins.values()) item.root.classList.toggle('maestro-window-front', item === win);
    }

    /** z-indexes of floats renumbered in their current stacking order (keeps them under ST's top bar). */
    private normalizeZ(): void {
        const floats = [...this.wins.values()]
            .filter((item) => item.place.dock === 'float')
            .sort((a, b) => Number(a.root.style.zIndex || 0) - Number(b.root.style.zIndex || 0));
        const front = this.recent[0];
        const ordered = [
            ...floats.filter((item) => item.spec.id !== front),
            ...floats.filter((i) => i.spec.id === front),
        ];
        this.zCounter = 0;
        for (const item of ordered) item.root.style.zIndex = String(FLOAT_Z + ++this.zCounter);
    }

    /* ---------------------------------------------------------------- internals: layout */

    private ensureRoot(): void {
        if (this.root) return;
        const side = (name: Side) => {
            const resizer = el('div', {
                class: 'maestro-window-resizer',
                attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-hidden': 'true' },
            });
            const node = el('div', { class: ['maestro-window-side', `maestro-window-side-${name}`] }, [resizer]);
            node.hidden = true;
            resizer.addEventListener('pointerdown', (event) => this.startSideResize(name, event));
            return node;
        };
        const sides = { left: side('left'), right: side('right') };
        const root = el('div', { class: 'maestro-ui maestro-windows' }, [sides.left, sides.right]);
        this.root = root;
        this.sides = sides;
        this.sheet = isSheetViewport();
        document.body.appendChild(root);
        const onKey = (event: KeyboardEvent) => this.onKey(event);
        const onPointer = (event: Event) => {
            const win = this.winOf(event.target);
            if (win && this.front() !== win.spec.id && !this.sheet) this.toFront(win);
        };
        const onViewport = () => this.onViewport();
        root.addEventListener('keydown', onKey);
        root.addEventListener('pointerdown', onPointer, true);
        root.addEventListener('focusin', onPointer);
        globalThis.addEventListener?.('resize', onViewport);
        this.rootOffs.push(() => globalThis.removeEventListener?.('resize', onViewport));
        try {
            const query = globalThis.matchMedia?.('(max-width: 1000px)');
            if (query?.addEventListener) {
                query.addEventListener('change', onViewport);
                this.rootOffs.push(() => query.removeEventListener('change', onViewport));
            }
        } catch {
            // no media queries: the resize listener covers it
        }
    }

    private removeRoot(): void {
        this.gesture?.();
        this.gesture = null;
        for (const off of this.rootOffs.splice(0)) off();
        this.root?.remove();
        this.root = null;
        this.sides = null;
    }

    private winOf(target: EventTarget | null): Win | undefined {
        if (!(target instanceof Element)) return undefined;
        const id = target.closest<HTMLElement>('.maestro-window')?.dataset.window;
        return id ? this.wins.get(id) : undefined;
    }

    /** Escape closes the window it was pressed in (its guard may keep it); ST's own Escape handling does not run. */
    private onKey(event: KeyboardEvent): void {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
        const win = this.winOf(event.target);
        if (!win) return;
        event.preventDefault();
        event.stopPropagation();
        this.close(win.spec.id);
    }

    private onViewport(): void {
        if (!this.root) return;
        this.sheet = isSheetViewport();
        for (const win of this.wins.values()) if (win.place.dock === 'float') this.ensureFloatRect(win);
        this.layoutAll();
    }

    private layoutAll(): void {
        if (!this.root || !this.sides) return;
        this.root.classList.toggle('maestro-windows-sheet', this.sheet);
        // The phone sheet takes the viewport height from here: 100dvh and the fixed containing block are not
        // reliable everywhere (a transformed or zero-height <html> makes `top/bottom: 0` collapse the sheet).
        const height = Number(globalThis.innerHeight) || 0;
        if (height > 0) this.root.style.setProperty('--maestro-viewport-h', `${height}px`);
        for (const win of this.wins.values()) this.placeWindow(win);
        this.layoutSides();
        for (const win of this.wins.values()) {
            this.syncSwitcher(win);
            this.sync(win);
        }
    }

    private placeWindow(win: Win): void {
        const root = this.root;
        const sides = this.sides;
        if (!root || !sides) return;
        const { place } = win;
        const floating = !this.sheet && place.dock === 'float';
        const node = win.root;
        node.classList.toggle('maestro-window-sheet', this.sheet);
        node.classList.toggle('maestro-window-float', floating);
        node.classList.toggle('maestro-window-docked', !this.sheet && !floating);
        node.classList.toggle('maestro-window-collapsed', !this.sheet && place.collapsed);
        node.dataset.dock = this.sheet ? 'sheet' : place.dock;
        const parent = this.sheet || floating ? root : sides[place.dock === 'left' ? 'left' : 'right'];
        if (node.parentElement !== parent) parent.appendChild(node);
        node.hidden = this.sheet && this.front() !== win.spec.id;
        const style = node.style;
        if (floating) {
            style.left = `${place.x ?? 0}px`;
            style.top = `${place.y ?? 0}px`;
            style.width = `${place.width ?? MIN_FLOAT_WIDTH}px`;
            style.height = place.collapsed ? '' : `${place.height ?? MIN_FLOAT_HEIGHT}px`;
            if (!style.zIndex) style.zIndex = String(FLOAT_Z + ++this.zCounter);
        } else {
            style.left = '';
            style.top = '';
            style.width = '';
            style.height = '';
            style.zIndex = '';
        }
        this.syncControls(win);
    }

    private layoutSides(): void {
        if (!this.sides) return;
        for (const name of SIDES) {
            const node = this.sides[name];
            const docked = [...node.children].filter(
                (child): child is HTMLElement =>
                    child instanceof HTMLElement && child.classList.contains('maestro-window'),
            );
            node.hidden = this.sheet || !docked.length;
            if (node.hidden) continue;
            if (this.layout.sides[name] === undefined) {
                const first = docked[0]?.dataset.window;
                this.layout.sides[name] = defaultSideWidth(
                    name,
                    first ? this.specs.get(first)?.defaultWidth : undefined,
                );
            }
            node.style.width = `${clampSideWidth(this.layout.sides[name] ?? 0)}px`;
            node.classList.toggle(
                'maestro-window-side-collapsed',
                docked.every((child) => child.classList.contains('maestro-window-collapsed')),
            );
        }
    }

    private persist(): void {
        for (const win of this.wins.values()) this.layout.windows[win.spec.id] = { ...win.place };
        saveLayout(this.layout);
    }

    /* ---------------------------------------------------------------- internals: drag and resize */

    /** Follows the pointer until it is released; one gesture at a time. */
    private track(
        event: PointerEvent,
        move: (dx: number, dy: number, ev: PointerEvent) => void,
        done: () => void,
    ): void {
        this.gesture?.();
        const startX = event.clientX;
        const startY = event.clientY;
        const onMove = (ev: PointerEvent) => move(ev.clientX - startX, ev.clientY - startY, ev);
        const finish = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', finish);
            document.removeEventListener('pointercancel', finish);
            this.root?.classList.remove('maestro-windows-dragging');
            if (this.gesture === finish) this.gesture = null;
            done();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
        this.root?.classList.add('maestro-windows-dragging');
        this.gesture = finish;
    }

    private startDrag(win: Win, event: PointerEvent): void {
        if (this.sheet || win.place.dock !== 'float' || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest('button, input, select, textarea, a')) return;
        event.preventDefault();
        this.toFront(win);
        const start = { x: win.place.x ?? 0, y: win.place.y ?? 0 };
        this.track(
            event,
            (dx, dy) => {
                const rect = clampFloat({
                    x: start.x + dx,
                    y: start.y + dy,
                    width: win.place.width ?? MIN_FLOAT_WIDTH,
                    height: win.place.height ?? MIN_FLOAT_HEIGHT,
                });
                win.place.x = rect.x;
                win.place.y = rect.y;
                win.root.style.left = `${rect.x}px`;
                win.root.style.top = `${rect.y}px`;
            },
            () => this.persist(),
        );
    }

    private startResize(win: Win, event: PointerEvent): void {
        if (this.sheet || win.place.dock !== 'float' || win.place.collapsed || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const start = { width: win.place.width ?? MIN_FLOAT_WIDTH, height: win.place.height ?? MIN_FLOAT_HEIGHT };
        const view = viewport();
        this.track(
            event,
            (dx, dy) => {
                const width = Math.max(MIN_FLOAT_WIDTH, Math.min(start.width + dx, view.width - (win.place.x ?? 0)));
                const height = Math.max(
                    MIN_FLOAT_HEIGHT,
                    Math.min(start.height + dy, view.height - (win.place.y ?? 0)),
                );
                win.place.width = Math.round(width);
                win.place.height = Math.round(height);
                win.root.style.width = `${win.place.width}px`;
                win.root.style.height = `${win.place.height}px`;
            },
            () => this.persist(),
        );
    }

    private startSideResize(side: Side, event: PointerEvent): void {
        if (this.sheet || event.button !== 0 || !this.sides) return;
        event.preventDefault();
        const node = this.sides[side];
        const start = this.layout.sides[side] ?? node.getBoundingClientRect().width;
        this.track(
            event,
            (dx) => {
                const width = clampSideWidth(side === 'left' ? start + dx : start - dx);
                this.layout.sides[side] = width;
                node.style.width = `${width}px`;
            },
            () => this.persist(),
        );
    }
}
