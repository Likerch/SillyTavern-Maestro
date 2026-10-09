// M39: the Dramatis tab in DES's «Character Sheet», the Dramatis pane in DES's Workshop and the «Dramatis» item of the
// portrait card menu (research: DES 2.6 template.html, characterSheet.js, characterWorkshop.js, portraitBar.js; NAI
// Studio's des-integration.ts installMenu / installWorkshop for the proven pattern).
//
// - DES fires no event when its windows open, so MutationObservers watch them: one on body (childList only) catches
//   DES's lazy template (appended to body the first time a DES modal opens) and the portrait menu moved into body; then
//   the sheet popup's attributes `style` / `data-cs-character` and the childList of its `.rpg-cs-sections` (emptied and
//   rebuilt on every open and on the Notes Mode toggle), and the Workshop's attributes `class` / `data-mode` /
//   `data-theme` (open, version switch). Injection is idempotent: Maestro's own append fires the observer again and
//   finds everything in place.
// - The sheet: a `.rpg-cs-tab[data-tab="dramatis"]` before the right-aligned Notes Mode toggle and a
//   `.rpg-cs-tab-content[data-tab="dramatis"]` (hidden until chosen) — DES's tab switching is document-delegated and
//   generic, so they work as its own. Never `.rpg-cs-section*` (DES's Copy collects them, its collapse handler toggles
//   them) nor `data-i18n-key`.
// - The Workshop (the only route on iOS, which has no context menu: Roster → Workshop): a `button[data-pane="dramatis"]`
//   in its nav and a `section.rpg-editor-pane[data-pane="dramatis"]` in its pane host — DES's activatePane switches
//   them. Read-only: nothing is written to DES while the Workshop is open (plan §10.8).
// - The portrait menu: an item next to «Character Sheet»; a capture-phase click opens DES's sheet programmatically
//   (DesAdapter.openCharacterSheet: DES's own ensureSettingsUI + openCharacterSheet) and switches to the Dramatis tab.
//   Hidden on the player's own card.
// - Every node carries `data-desru-skip` (DES-RU's translator leaves the subtree alone) and a `maestro-m39-*` class.
// - Dramatis' summary is read live (describe) on every open, and again while shown when Dramatis says something changed
//   (DRAMATIS_API.onChange through the adapter, which also follows a Dramatis that loads later). Without describe
//   (Dramatis absent, off or older than 1.3) nothing is added, and what was added goes.
// - dispose(): every node, observer, listener and menu item goes; a Dramatis tab or pane on screen hands back to DES's
//   «Sheet» tab / «Identity» pane first.
import { adaptersOf, dramatisOf } from '../../adapters';
import type { DramatisAdapter, DramatisCharacterView } from '../../adapters';
import { DES_UI } from '../../adapters/des';
import { normName } from '../../domain/dossier-names';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import { el, icon } from '../../ui/components/dom';
import { renderDramatis } from './view';
import type { DramatisContent, DramatisHost } from './view';

/** DES's tab / pane id of the Dramatis section. */
export const DRAMATIS_TAB = 'dramatis';
/** DES-RU leaves a subtree with this attribute untranslated. */
export const DESRU_SKIP = 'data-desru-skip';
export const M39_NODES = {
    tab: 'maestro-m39-tab',
    content: 'maestro-m39-content',
    nav: 'maestro-m39-nav',
    pane: 'maestro-m39-pane',
    menu: 'maestro-m39-ctx',
} as const;

/** The parts of jQuery Maestro touches (DES keeps the menu's character in jQuery data). */
interface JQueryLike {
    data(key: string): unknown;
    hide(): unknown;
    off(events: string): unknown;
}
type JQueryFn = (target: unknown) => JQueryLike;

function jquery(): JQueryFn | null {
    const value = (globalThis as { jQuery?: unknown }).jQuery;
    return typeof value === 'function' ? (value as JQueryFn) : null;
}

function page(): Document | null {
    return typeof document === 'undefined' ? null : document;
}

/** Dramatis' methods M39 uses (an older test double or an older Dramatis may lack them). */
type DramatisReader = Partial<Pick<DramatisAdapter, 'canDescribe' | 'describe' | 'canOpenSheet' | 'openSheet'>> & {
    onChange?(listener: () => void): () => void;
};

export class DesDramatisUi {
    private bodyObserver: MutationObserver | null = null;
    private sheet: { popup: HTMLElement; observer: MutationObserver; sections: Element | null } | null = null;
    private workshop: { popup: HTMLElement; observer: MutationObserver } | null = null;
    private readonly offs: Unsubscribe[] = [];
    /** Secret lines the user revealed (until the chat changes). */
    private readonly revealed = new Set<string>();
    /** The card the menu was opened on (DES keeps it in jQuery data; this is the fallback). */
    private lastCard: { name: string; isUser: boolean } | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    install(): void {
        const doc = page();
        if (!doc) return;
        if (typeof MutationObserver !== 'undefined' && doc.body) {
            this.bodyObserver = new MutationObserver(() => this.scan());
            this.bodyObserver.observe(doc.body, { childList: true });
        }
        const onContext = (event: Event) => this.onContextMenu(event);
        const onClick = (event: Event) => this.onMenuClick(event);
        doc.addEventListener('contextmenu', onContext, true);
        doc.addEventListener('click', onClick, true);
        this.offs.push(() => {
            doc.removeEventListener('contextmenu', onContext, true);
            doc.removeEventListener('click', onClick, true);
        });
        const dramatis = this.dramatis();
        if (typeof dramatis?.onChange === 'function') {
            const off = dramatis.onChange(() => this.refresh(true));
            this.offs.push(off);
        }
        this.offs.push(
            this.app.bus.on('chat:changed', () => {
                this.revealed.clear();
                this.refresh(true);
            }),
        );
        this.scan();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.log.debug('M39: a listener did not detach', error);
            }
        }
        this.bodyObserver?.disconnect();
        this.bodyObserver = null;
        this.sheet?.observer.disconnect();
        this.workshop?.observer.disconnect();
        const doc = page();
        const sheet = doc?.getElementById(DES_UI.sheet);
        const workshop = doc?.getElementById(DES_UI.workshop);
        if (sheet) this.removeSheet(sheet);
        if (workshop) this.removeWorkshop(workshop);
        doc?.querySelectorAll(`.${M39_NODES.menu}`).forEach((node) => node.remove());
        this.sheet = null;
        this.workshop = null;
    }

    /* ---------------------------------------------------------------- what is shown */

    private dramatis(): DramatisReader | undefined {
        try {
            return dramatisOf(this.app) as DramatisReader | undefined;
        } catch {
            return undefined;
        }
    }

    /** Dramatis is there and gives summaries (1.3). */
    available(): boolean {
        const dramatis = this.dramatis();
        try {
            return typeof dramatis?.canDescribe === 'function' && dramatis.canDescribe();
        } catch {
            return false;
        }
    }

    private canOpen(): boolean {
        const dramatis = this.dramatis();
        try {
            return typeof dramatis?.canOpenSheet === 'function' && dramatis.canOpenSheet();
        } catch {
            return false;
        }
    }

    private openDramatis(name?: string): void {
        try {
            this.dramatis()?.openSheet?.(name);
        } catch (error) {
            this.log.warn('M39: Dramatis did not open', error);
        }
    }

    private desSettings(): Record<string, unknown> | null {
        try {
            const settings = adaptersOf(this.app).des.settings();
            return settings && typeof settings === 'object' ? settings : null;
        } catch {
            return null;
        }
    }

    /** The persona: ST's user name, DES's user characters and its active one. */
    private isPersona(name: string): boolean {
        const key = normName(name);
        if (!key) return false;
        const names: unknown[] = [];
        try {
            names.push(this.app.host.ctx().name1);
        } catch {
            // no context in this environment
        }
        const settings = this.desSettings();
        const users = settings?.userCharacters;
        if (users && typeof users === 'object') names.push(...Object.keys(users));
        names.push(settings?.activeUserCharacter);
        return names.some((candidate) => normName(candidate) === key);
    }

    /** The DES name first, then its aliases (DES's names are canonical; Dramatis resolves forms itself). */
    private candidates(name: string): string[] {
        const out = [name];
        const key = normName(name);
        let aliases: Record<string, string[]>;
        try {
            aliases = adaptersOf(this.app).des.aliases();
        } catch {
            aliases = {};
        }
        for (const [canonical, list] of Object.entries(aliases)) {
            if (normName(canonical) === key) out.push(...list);
            else if (list.some((alias) => normName(alias) === key)) out.push(canonical, ...list);
        }
        const seen = new Set<string>();
        return out.filter((candidate) => {
            const id = normName(candidate);
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }

    private describe(name: string): DramatisCharacterView | null {
        const dramatis = this.dramatis();
        if (typeof dramatis?.describe !== 'function') return null;
        for (const candidate of this.candidates(name).slice(0, 8)) {
            try {
                const view = dramatis.describe(candidate);
                if (view) return view;
            } catch (error) {
                this.log.debug('M39: describe failed', error);
            }
        }
        return null;
    }

    content(name: string, user = false): DramatisContent {
        if (user || this.isPersona(name)) return { kind: 'persona', name };
        const view = this.describe(name);
        return view ? { kind: 'view', name, view } : { kind: 'empty', name };
    }

    private render(container: HTMLElement, name: string, host: DramatisHost, user = false): void {
        container.dataset.name = name;
        container.dataset.mode = user ? 'user' : 'npc';
        renderDramatis(container, this.content(name, user), {
            t: (key, params) => this.t(key, params),
            host,
            canOpen: this.canOpen(),
            open: (target) => this.openDramatis(target),
            revealed: this.revealed,
        });
    }

    /* ---------------------------------------------------------------- finding DES's windows */

    /** Looks for DES's windows and menu (cheap: three lookups by id). */
    scan(): void {
        if (this.disposed) return;
        this.syncSheet();
        this.syncWorkshop();
        this.syncMenu();
    }

    /** Everything again; `force` redraws the contents (Dramatis changed, another chat). */
    refresh(force = false): void {
        if (this.disposed) return;
        this.syncSheet(force);
        this.syncWorkshop(force);
        this.syncMenu();
    }

    private observe(target: Node, options: MutationObserverInit, run: () => void): MutationObserver | null {
        if (typeof MutationObserver === 'undefined') return null;
        const observer = new MutationObserver(() => run());
        observer.observe(target, options);
        return observer;
    }

    /* ---------------------------------------------------------------- the character sheet */

    private watchSheet(popup: HTMLElement): void {
        const sections = popup.querySelector('.rpg-cs-sections');
        if (this.sheet?.popup === popup && this.sheet.sections === sections) return;
        this.sheet?.observer.disconnect();
        const observer = this.observe(
            popup,
            { attributes: true, attributeFilter: ['style', 'data-cs-character'] },
            () => this.syncSheet(),
        );
        if (!observer) return;
        if (sections) observer.observe(sections, { childList: true });
        this.sheet = { popup, observer, sections };
    }

    syncSheet(force = false): void {
        const popup = page()?.getElementById(DES_UI.sheet);
        if (!popup || this.disposed) return;
        this.watchSheet(popup);
        if (!this.available()) {
            this.removeSheet(popup);
            return;
        }
        const sections = popup.querySelector<HTMLElement>('.rpg-cs-sections');
        const tabs = sections?.querySelector<HTMLElement>(':scope > .rpg-cs-tabs');
        if (!sections || !tabs) return;
        if (!tabs.querySelector(`.${M39_NODES.tab}`)) {
            const tab = el(
                'div',
                {
                    class: ['rpg-cs-tab', M39_NODES.tab],
                    title: this.t('m39.tabTitle'),
                    data: { tab: DRAMATIS_TAB },
                    attrs: { [DESRU_SKIP]: true },
                },
                [
                    icon('fa-masks-theater'),
                    ' ',
                    el('span', { class: 'maestro-m39-tab-label', text: this.t('m39.tab') }),
                ],
            );
            // Before DES's right-aligned Notes Mode toggle, after its own tabs.
            tabs.insertBefore(tab, tabs.querySelector(':scope > .rpg-cs-mode-toggle'));
        }
        let content = sections.querySelector<HTMLElement>(`:scope > .${M39_NODES.content}`);
        const name = popup.getAttribute('data-cs-character') ?? '';
        if (!content) {
            content = el('div', {
                class: ['rpg-cs-tab-content', M39_NODES.content],
                data: { tab: DRAMATIS_TAB },
                attrs: { [DESRU_SKIP]: true },
            });
            content.style.display = 'none';
            sections.appendChild(content);
            this.render(content, name, 'sheet');
        } else if (force || content.dataset.name !== name) {
            this.render(content, name, 'sheet');
        }
    }

    private removeSheet(popup: HTMLElement): void {
        const tab = popup.querySelector<HTMLElement>(`.${M39_NODES.tab}`);
        const content = popup.querySelector<HTMLElement>(`.${M39_NODES.content}`);
        if (tab?.classList.contains('active')) {
            // DES's own tab switching shows its sheet again; done by hand when DES's handler is not there.
            const sheetTab = popup.querySelector<HTMLElement>('.rpg-cs-tab[data-tab="sheet"]');
            sheetTab?.click();
            const sheetContent = popup.querySelector<HTMLElement>('.rpg-cs-tab-content[data-tab="sheet"]');
            if (sheetTab && !sheetTab.classList.contains('active')) sheetTab.classList.add('active');
            if (sheetContent?.style.display === 'none') sheetContent.style.display = '';
        }
        tab?.remove();
        content?.remove();
    }

    /* ---------------------------------------------------------------- the Workshop */

    private watchWorkshop(popup: HTMLElement): void {
        if (this.workshop?.popup === popup) return;
        this.workshop?.observer.disconnect();
        const observer = this.observe(
            popup,
            { attributes: true, attributeFilter: ['class', 'data-mode', 'data-theme'] },
            () => this.syncWorkshop(true),
        );
        if (observer) this.workshop = { popup, observer };
    }

    syncWorkshop(draw = false): void {
        const popup = page()?.getElementById(DES_UI.workshop);
        if (!popup || this.disposed) return;
        this.watchWorkshop(popup);
        if (!this.available()) {
            this.removeWorkshop(popup);
            return;
        }
        const nav = popup.querySelector<HTMLElement>('nav.workshop-nav');
        const host = popup.querySelector<HTMLElement>('.workshop-pane-host');
        if (!nav || !host) return;
        if (!nav.querySelector(`.${M39_NODES.nav}`)) {
            nav.appendChild(
                el(
                    'button',
                    {
                        class: M39_NODES.nav,
                        title: this.t('m39.tabTitle'),
                        data: { pane: DRAMATIS_TAB },
                        attrs: { type: 'button', [DESRU_SKIP]: true },
                    },
                    ['\u{1F3AD} ', el('span', { class: 'cw-tab-label', text: this.t('m39.tab') })],
                ),
            );
        }
        let pane = host.querySelector<HTMLElement>(`:scope > .${M39_NODES.pane}`);
        if (!pane) {
            pane = el('section', {
                class: ['rpg-editor-pane', M39_NODES.pane],
                data: { pane: DRAMATIS_TAB },
                attrs: { [DESRU_SKIP]: true },
            });
            host.appendChild(pane);
        }
        // Drawn while open only: every opening, version switch or theme change (`draw`), a change in Dramatis (forced)
        // or another character draws it again (the reveals are kept); other page changes leave it be. A closed
        // Workshop is drawn when it opens.
        if (!popup.classList.contains('is-open')) return;
        const name = (popup.querySelector('#cw-char-title')?.textContent ?? '').trim();
        const user = popup.getAttribute('data-mode') === 'user';
        if (draw || pane.dataset.name !== name || pane.dataset.mode !== (user ? 'user' : 'npc')) {
            this.render(pane, name, 'workshop', user);
        }
    }

    private removeWorkshop(popup: HTMLElement): void {
        const button = popup.querySelector<HTMLElement>(`.${M39_NODES.nav}`);
        const pane = popup.querySelector<HTMLElement>(`.${M39_NODES.pane}`);
        if (button?.classList.contains('active') || pane?.classList.contains('active')) {
            popup.querySelector<HTMLElement>('.workshop-nav button[data-pane="identity"]')?.click();
        }
        button?.remove();
        pane?.remove();
    }

    /* ---------------------------------------------------------------- the portrait card menu */

    private menuItem(menu: Element): HTMLElement | null {
        return menu.querySelector<HTMLElement>(`.${M39_NODES.menu}`);
    }

    syncMenu(): HTMLElement | null {
        const menu = page()?.getElementById(DES_UI.contextMenu);
        if (!menu || this.disposed) return null;
        const existing = this.menuItem(menu);
        if (!this.available()) {
            existing?.remove();
            return null;
        }
        if (existing) return existing;
        const item = el(
            'div',
            {
                class: ['dooms-pb-ctx-item', M39_NODES.menu],
                title: this.t('m39.menuTitle'),
                attrs: { [DESRU_SKIP]: true },
            },
            [icon('fa-masks-theater'), ' ', this.t('m39.menu')],
        );
        const sheetItem = menu.querySelector('[data-action="character-sheet"]');
        if (sheetItem) sheetItem.after(item);
        else menu.appendChild(item);
        return item;
    }

    /** Before DES shows its menu: the item is there, and hidden on the player's own card. */
    private onContextMenu(event: Event): void {
        const target = event.target instanceof Element ? event.target : null;
        const card = target?.closest('.dooms-portrait-card');
        if (!card) return;
        const name = card.getAttribute('data-char') || card.getAttribute('title') || '';
        const isUser = card.getAttribute('data-user') === '1';
        this.lastCard = { name, isUser };
        const item = this.syncMenu();
        if (item) item.style.display = isUser || this.isPersona(name) ? 'none' : '';
    }

    private menuCharacter(): string {
        const $ = jquery();
        if ($) {
            try {
                const value = $(`#${DES_UI.contextMenu}`).data('character');
                if (typeof value === 'string' && value.trim()) return value.trim();
            } catch {
                // fall back to the card seen on contextmenu
            }
        }
        return this.lastCard?.name.trim() ?? '';
    }

    /** Hides DES's menu as DES does (portraitBar.js hideContextMenu). */
    private hideMenu(): void {
        const $ = jquery();
        if ($) {
            try {
                $(`#${DES_UI.contextMenu}`).hide();
                $(document).off('click.dooms-pb-ctx');
                return;
            } catch {
                // the plain way below
            }
        }
        const menu = page()?.getElementById(DES_UI.contextMenu);
        if (menu) menu.style.display = 'none';
    }

    private onMenuClick(event: Event): void {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest(`.${M39_NODES.menu}`)) return;
        // Ours alone: DES's delegated item handler would only hide the menu.
        event.preventDefault();
        event.stopPropagation();
        const name = this.menuCharacter();
        this.hideMenu();
        if (name) void this.openSheetOn(name);
    }

    /** Opens DES's character sheet of this character on the Dramatis tab. */
    async openSheetOn(name: string): Promise<boolean> {
        const des = adaptersOf(this.app).des as unknown as { openCharacterSheet?(name: string): Promise<boolean> };
        let opened = false;
        try {
            opened = typeof des.openCharacterSheet === 'function' && (await des.openCharacterSheet(name));
        } catch (error) {
            this.log.warn('M39: the character sheet did not open', error);
        }
        if (this.disposed) return false;
        if (!opened) {
            this.app.ui.notice(this.t('m39.openFailed'), { urgent: true, level: 'warn' });
            return false;
        }
        // DES filled the popup in one synchronous pass; the observer would come a moment later.
        this.syncSheet();
        const tab = page()
            ?.getElementById(DES_UI.sheet)
            ?.querySelector<HTMLElement>(`.rpg-cs-tab[data-tab="${DRAMATIS_TAB}"]`);
        if (!tab) return false;
        tab.click();
        return true;
    }
}
