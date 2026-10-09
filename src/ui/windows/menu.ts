// A small drop-down menu anchored to a button (the top-bar icon, the wand item, a message's Maestro button, the button
// at the message box). It is Maestro's own body-level node: closed by a click elsewhere, Escape, choosing an item or a
// resize; arrow keys move between items. An item with a submenu opens it in place, with «Назад» on top (ArrowLeft goes
// back). Phones (≤1000px) get it full width with 44px rows: under the anchor, or above it when the anchor sits low
// (the message box).
import type { Logger } from '../../shared/contracts';
import { el, icon } from '../components/dom';
import { progressBar } from '../components/progress';
import { isSheetViewport, viewport } from './layout';

export interface MenuItem {
    id: string;
    label: string;
    icon?: string;
    badge?: number;
    /** A second, quieter line (a job's status). */
    hint?: string;
    /** Marks an item that is already open/on. */
    active?: boolean;
    /** A job's progress bar: done/total, or indeterminate with `total` undefined. */
    progress?: { done?: number; total?: number };
    run(): void;
    /** A nested list opened in place instead of running (built when opened). */
    submenu?(): MenuGroup[];
}

export interface MenuGroup {
    label?: string;
    items: MenuItem[];
}

export interface MenuOptions {
    /** Accessible name of the menu. */
    label: string;
    className?: string;
    /** Called once when the menu closes (for aria-expanded on the anchor). */
    onClose?(): void;
    /** Label of the item that leaves a submenu (translated). */
    backLabel?: string;
}

const MARGIN = 8;

export class FloatingMenu {
    private node: HTMLElement | null = null;
    private anchor: HTMLElement | null = null;
    private options: MenuOptions | null = null;
    /** The root groups (kept up to date by update()) and the open submenus, innermost last. */
    private root: MenuGroup[] = [];
    private readonly stack: { item: MenuItem; groups: MenuGroup[] }[] = [];
    private readonly offs: (() => void)[] = [];

    constructor(private readonly log: Logger) {}

    isOpen(): boolean {
        return this.node !== null;
    }

    anchorNode(): HTMLElement | null {
        return this.anchor;
    }

    open(anchor: HTMLElement, groups: MenuGroup[], options: MenuOptions): void {
        this.close();
        this.anchor = anchor;
        this.options = options;
        const node = el('div', {
            class: ['maestro-ui', 'maestro-menu', options.className],
            attrs: { role: 'menu', 'aria-label': options.label, tabindex: '-1' },
        });
        this.node = node;
        this.root = groups;
        this.stack.length = 0;
        this.fill(groups);
        document.body.appendChild(node);
        this.place();
        node.addEventListener('keydown', (event) => this.onKey(event));
        const outside = (event: Event) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (this.node?.contains(target) || this.anchor?.contains(target)) return;
            this.close();
        };
        const resize = () => this.close();
        document.addEventListener('pointerdown', outside, true);
        globalThis.addEventListener?.('resize', resize);
        this.offs.push(
            () => document.removeEventListener('pointerdown', outside, true),
            () => globalThis.removeEventListener?.('resize', resize),
        );
        this.focusItem(0);
    }

    /** Re-renders the items of the open menu (badges, jobs) without moving it; an open submenu stays. */
    update(groups: MenuGroup[]): void {
        if (!this.node) return;
        this.root = groups;
        if (this.stack.length) return;
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.item : undefined;
        this.fill(groups);
        if (focused)
            this.items()
                .find((item) => item.dataset.item === focused)
                ?.focus();
    }

    close(): void {
        const node = this.node;
        if (!node) return;
        for (const off of this.offs.splice(0)) off();
        const hadFocus = node.contains(document.activeElement);
        node.remove();
        this.node = null;
        this.root = [];
        this.stack.length = 0;
        const anchor = this.anchor;
        const onClose = this.options?.onClose;
        this.anchor = null;
        this.options = null;
        try {
            onClose?.();
        } catch (error) {
            this.log.warn('menu close handler failed', error);
        }
        if (hadFocus && anchor?.isConnected) anchor.focus?.();
    }

    dispose(): void {
        this.close();
    }

    /** The id of the item whose submenu is open (the innermost), null at the top level. */
    submenuOf(): string | null {
        return this.stack[this.stack.length - 1]?.item.id ?? null;
    }

    private openSubmenu(item: MenuItem): void {
        let groups: MenuGroup[] = [];
        try {
            groups = item.submenu?.() ?? [];
        } catch (error) {
            this.log.error(`submenu "${item.id}" failed`, error);
        }
        this.stack.push({ item, groups });
        this.fill(groups);
        this.place();
        this.focusItem(1);
    }

    private back(): void {
        if (!this.stack.length) return;
        this.stack.pop();
        const top = this.stack[this.stack.length - 1];
        this.fill(top ? top.groups : this.root);
        this.place();
        this.focusItem(0);
    }

    private fill(groups: MenuGroup[]): void {
        const node = this.node;
        if (!node) return;
        const top = this.stack[this.stack.length - 1];
        const head = top
            ? [
                  el('div', { class: 'maestro-menu-group maestro-menu-back-group' }, [
                      this.itemNode({
                          id: '__back',
                          label: this.options?.backLabel ?? '←',
                          icon: 'fa-arrow-left',
                          run: () => this.back(),
                      }),
                      el('div', { class: 'maestro-menu-heading maestro-menu-title', text: top.item.label }),
                  ]),
              ]
            : [];
        node.replaceChildren(
            ...head,
            ...groups
                .filter((group) => group.items.length)
                .map((group) =>
                    el('div', { class: 'maestro-menu-group', attrs: { role: 'group', 'aria-label': group.label } }, [
                        group.label ? el('div', { class: 'maestro-menu-heading', text: group.label }) : null,
                        ...group.items.map((item) => this.itemNode(item)),
                    ]),
                ),
        );
    }

    private itemNode(item: MenuItem): HTMLElement {
        const badge = item.badge && item.badge > 0 ? (item.badge > 99 ? '99+' : String(item.badge)) : null;
        const node = el(
            'button',
            {
                class: ['maestro-menu-item', item.active ? 'maestro-on' : null],
                data: { item: item.id },
                attrs: { type: 'button', role: 'menuitem', tabindex: '-1' },
            },
            [
                item.icon ? icon(item.icon, 'maestro-menu-icon') : null,
                el('span', { class: 'maestro-menu-text' }, [
                    el('span', { class: 'maestro-menu-label', text: item.label }),
                    item.hint ? el('span', { class: 'maestro-menu-hint', text: item.hint }) : null,
                    item.progress
                        ? progressBar(item.progress.done, item.progress.total, item.hint ?? item.label)
                        : null,
                ]),
                badge ? el('span', { class: 'maestro-menu-badge', text: badge }) : null,
                item.active ? el('span', { class: 'maestro-menu-dot', attrs: { 'aria-hidden': 'true' } }) : null,
                item.submenu ? icon('fa-chevron-right', 'maestro-menu-more') : null,
            ],
        );
        if (item.submenu) node.setAttribute('aria-haspopup', 'menu');
        node.addEventListener('click', (event) => {
            event.stopPropagation();
            if (item.id === '__back') {
                this.back();
                return;
            }
            if (item.submenu) {
                this.openSubmenu(item);
                return;
            }
            this.close();
            try {
                item.run();
            } catch (error) {
                this.log.error(`menu item "${item.id}" failed`, error);
            }
        });
        return node;
    }

    private items(): HTMLElement[] {
        return [...(this.node?.querySelectorAll<HTMLElement>('.maestro-menu-item') ?? [])];
    }

    private focusItem(index: number): void {
        const items = this.items();
        if (!items.length) {
            this.node?.focus();
            return;
        }
        items[(index + items.length) % items.length]?.focus();
    }

    private onKey(event: KeyboardEvent): void {
        const items = this.items();
        const current = items.indexOf(document.activeElement as HTMLElement);
        switch (event.key) {
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                this.close();
                return;
            case 'ArrowDown':
                event.preventDefault();
                this.focusItem(current + 1);
                return;
            case 'ArrowUp':
                event.preventDefault();
                this.focusItem(current - 1);
                return;
            case 'Home':
                event.preventDefault();
                this.focusItem(0);
                return;
            case 'End':
                event.preventDefault();
                this.focusItem(items.length - 1);
                return;
            case 'ArrowLeft':
            case 'Backspace':
                if (!this.stack.length) return;
                event.preventDefault();
                this.back();
                return;
            case 'ArrowRight': {
                const item = items[current];
                if (!item?.getAttribute('aria-haspopup')) return;
                event.preventDefault();
                item.click();
                return;
            }
            case 'Tab':
                this.close();
                return;
            default:
        }
    }

    /**
     * Under the anchor (above it when there is no room below), inside the screen; full width on phones, above the
     * anchor when it sits in the lower half (the message box).
     */
    private place(): void {
        const node = this.node;
        const anchor = this.anchor;
        if (!node || !anchor) return;
        const view = viewport();
        const rect = anchor.getBoundingClientRect();
        if (isSheetViewport()) {
            node.classList.add('maestro-menu-sheet');
            node.style.left = `${MARGIN}px`;
            node.style.right = `${MARGIN}px`;
            const low = view.height > 0 && rect.top > view.height / 2;
            node.classList.toggle('maestro-menu-up', low);
            if (low) {
                node.style.top = '';
                node.style.bottom = `${Math.max(MARGIN, Math.round(view.height - rect.top + 4))}px`;
                node.style.maxHeight = `${Math.max(120, Math.round(rect.top - 4 - MARGIN))}px`;
            } else {
                node.style.bottom = '';
                node.style.maxHeight = '';
                node.style.top = `${Math.max(MARGIN, Math.round(rect.bottom + 4))}px`;
            }
            return;
        }
        const width = node.offsetWidth || 300;
        const height = node.offsetHeight || 0;
        let left = Math.round(rect.left);
        if (left + width > view.width - MARGIN) left = Math.round(rect.right - width);
        left = Math.max(MARGIN, Math.min(left, view.width - width - MARGIN));
        const below = rect.bottom + 4;
        const above = rect.top - 4 - height;
        const top = below + height > view.height - MARGIN && above >= MARGIN ? above : below;
        node.style.left = `${left}px`;
        node.style.top = `${Math.max(MARGIN, Math.round(top))}px`;
    }
}
