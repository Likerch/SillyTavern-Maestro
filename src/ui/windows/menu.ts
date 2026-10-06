// A small drop-down menu anchored to a button (the top-bar icon, the wand item, a message's Maestro button). It is
// Maestro's own body-level node: closed by a click elsewhere, Escape, choosing an item or a resize; arrow keys move
// between items. Phones (≤1000px) get it full width under the top bar with 44px rows.
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
}

const MARGIN = 8;

export class FloatingMenu {
    private node: HTMLElement | null = null;
    private anchor: HTMLElement | null = null;
    private options: MenuOptions | null = null;
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

    /** Re-renders the items of the open menu (badges, jobs) without moving it. */
    update(groups: MenuGroup[]): void {
        if (!this.node) return;
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

    private fill(groups: MenuGroup[]): void {
        const node = this.node;
        if (!node) return;
        node.replaceChildren(
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
            ],
        );
        node.addEventListener('click', (event) => {
            event.stopPropagation();
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
            case 'Tab':
                this.close();
                return;
            default:
        }
    }

    /** Under the anchor (above it when there is no room below), inside the screen; full width on phones. */
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
            node.style.top = `${Math.max(MARGIN, Math.round(rect.bottom + 4))}px`;
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
