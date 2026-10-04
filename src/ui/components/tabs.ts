// Tab list with keyboard navigation (desktop: vertical list) plus a <select> twin for phones; the stylesheet
// shows one or the other at ST's 1000px breakpoint.
import { el, icon } from './dom';

export interface TabItem {
    id: string;
    label: string;
    icon?: string;
    badge?: number;
}

export interface TabsOptions {
    items: TabItem[];
    active?: string;
    /** Accessible name of the tab list. */
    label: string;
    onSelect(id: string): void;
}

export interface TabsHandle {
    /** The vertical tab list. */
    list: HTMLElement;
    /** The phone tab selector. */
    picker: HTMLSelectElement;
    setItems(items: TabItem[]): void;
    setActive(id: string): void;
    setBadge(id: string, value: number): void;
    active(): string | null;
}

export function tabs(options: TabsOptions): TabsHandle {
    const list = el('div', {
        class: 'maestro-tabs',
        attrs: { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': options.label },
    });
    const picker = el('select', { class: 'text_pole maestro-tabs-picker', attrs: { 'aria-label': options.label } });
    let items: TabItem[] = [];
    let current: string | null = options.active ?? null;

    const buttonOf = (id: string) =>
        [...list.querySelectorAll<HTMLButtonElement>('.maestro-tab')].find((node) => node.dataset.tab === id) ?? null;

    const pickerLabel = (item: TabItem) => (item.badge ? `${item.label} (${item.badge})` : item.label);

    const render = () => {
        list.replaceChildren();
        picker.replaceChildren();
        for (const item of items) {
            const badge = el('span', { class: 'maestro-tab-badge', text: item.badge ? String(item.badge) : '' });
            badge.hidden = !item.badge;
            const node = el(
                'button',
                {
                    class: 'maestro-tab',
                    data: { tab: item.id },
                    attrs: { type: 'button', role: 'tab', 'aria-selected': 'false', tabindex: '-1' },
                },
                [
                    item.icon ? icon(item.icon) : null,
                    el('span', { class: 'maestro-tab-label', text: item.label }),
                    badge,
                ],
            );
            node.addEventListener('click', () => choose(item.id));
            list.appendChild(node);
            picker.appendChild(el('option', { text: pickerLabel(item), attrs: { value: item.id } }));
        }
        mark();
    };

    const mark = () => {
        if (current === null || !items.some((item) => item.id === current)) current = items[0]?.id ?? null;
        for (const node of list.querySelectorAll<HTMLButtonElement>('.maestro-tab')) {
            const on = node.dataset.tab === current;
            node.classList.toggle('maestro-on', on);
            node.setAttribute('aria-selected', on ? 'true' : 'false');
            node.setAttribute('tabindex', on ? '0' : '-1');
        }
        if (current !== null) picker.value = current;
    };

    const choose = (id: string) => {
        if (!items.some((item) => item.id === id)) return;
        current = id;
        mark();
        options.onSelect(id);
    };

    list.addEventListener('keydown', (event) => {
        const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(event.key) || !items.length) return;
        event.preventDefault();
        const index = Math.max(
            0,
            items.findIndex((item) => item.id === current),
        );
        let next: number;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % items.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
        else if (event.key === 'Home') next = 0;
        else next = items.length - 1;
        const target = items[next];
        if (!target) return;
        choose(target.id);
        buttonOf(target.id)?.focus();
    });
    picker.addEventListener('change', () => choose(picker.value));

    const handle: TabsHandle = {
        list,
        picker,
        setItems(next) {
            items = [...next];
            render();
        },
        setActive(id) {
            if (!items.some((item) => item.id === id)) return;
            current = id;
            mark();
        },
        setBadge(id, value) {
            const item = items.find((entry) => entry.id === id);
            if (!item || (item.badge ?? 0) === value) return;
            item.badge = value;
            const badge = buttonOf(id)?.querySelector<HTMLElement>('.maestro-tab-badge');
            if (badge) {
                badge.textContent = value ? String(value) : '';
                badge.hidden = !value;
            }
            const option = [...picker.options].find((entry) => entry.value === id);
            if (option) option.textContent = pickerLabel(item);
        },
        active: () => current,
    };
    handle.setItems(options.items);
    return handle;
}
