// Tab list with keyboard navigation (desktop: vertical list) plus a <select> twin for phones; the stylesheet
// shows one or the other at ST's 1000px breakpoint. Consecutive items of one group get a collapsible heading
// (the picker uses <optgroup>); a group of a single item is shown as a plain tab, a heading over one tab is noise.
import { el, icon } from './dom';

export interface TabItem {
    id: string;
    label: string;
    icon?: string;
    badge?: number;
    /** Group id; consecutive items of one group are shown under one heading. */
    group?: string;
    /** Heading of the group (items without it are shown flat). */
    groupLabel?: string;
}

export interface TabsOptions {
    items: TabItem[];
    active?: string;
    /** Accessible name of the tab list. */
    label: string;
    onSelect(id: string): void;
    /** localStorage key that remembers collapsed groups in this browser (none: not remembered). */
    storageKey?: string;
    /** Tooltip of a group heading. */
    groupTitle?(collapsed: boolean): string;
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
    /** Collapses or expands a group heading (remembered like a click). */
    setCollapsed(group: string, collapsed: boolean): void;
    collapsed(): string[];
}

interface Block {
    /** Group id, or null for a plain tab. */
    group: string | null;
    label: string;
    items: TabItem[];
}

let instances = 0;

/** localStorage may throw (private mode, blocked site data) or be missing: collapsing then just is not remembered. */
function readCollapsed(key: string | undefined): Set<string> {
    if (!key) return new Set();
    try {
        const raw = globalThis.localStorage?.getItem(key);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return new Set(
            Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [],
        );
    } catch {
        return new Set();
    }
}

function writeCollapsed(key: string | undefined, groups: Set<string>): void {
    if (!key) return;
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify([...groups].sort()));
    } catch {
        // Not remembered in this browser; the state still holds for this page.
    }
}

/** Splits items into plain tabs and groups of consecutive items (a group of one item is a plain tab). */
function blocksOf(items: TabItem[]): Block[] {
    const blocks: Block[] = [];
    for (const item of items) {
        const group = item.group && item.groupLabel ? item.group : null;
        const last = blocks[blocks.length - 1];
        if (group !== null && last && last.group === group) last.items.push(item);
        else blocks.push({ group, label: item.groupLabel ?? '', items: [item] });
    }
    return blocks.flatMap((block) =>
        block.group !== null && block.items.length < 2
            ? block.items.map((item) => ({ group: null, label: '', items: [item] }))
            : [block],
    );
}

export function tabs(options: TabsOptions): TabsHandle {
    const prefix = `maestro-tabs-${++instances}`;
    const list = el('div', {
        class: 'maestro-tabs',
        attrs: { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': options.label },
    });
    const picker = el('select', { class: 'text_pole maestro-tabs-picker', attrs: { 'aria-label': options.label } });
    let items: TabItem[] = [];
    let blocks: Block[] = [];
    let current: string | null = options.active ?? null;
    const collapsedGroups = readCollapsed(options.storageKey);

    const buttonOf = (id: string) =>
        [...list.querySelectorAll<HTMLButtonElement>('.maestro-tab')].find((node) => node.dataset.tab === id) ?? null;
    const groupNodeOf = (group: string) =>
        [...list.querySelectorAll<HTMLElement>('.maestro-tab-group')].find((node) => node.dataset.group === group) ??
        null;
    const blockOf = (id: string) => blocks.find((block) => block.items.some((item) => item.id === id));
    const hidden = (item: TabItem) => {
        const block = blockOf(item.id);
        return !!block?.group && collapsedGroups.has(block.group);
    };

    const pickerLabel = (item: TabItem) => (item.badge ? `${item.label} (${item.badge})` : item.label);

    const tabButton = (item: TabItem): HTMLButtonElement => {
        const badge = el('span', { class: 'maestro-tab-badge', text: item.badge ? String(item.badge) : '' });
        badge.hidden = !item.badge;
        const node = el(
            'button',
            {
                class: 'maestro-tab',
                data: { tab: item.id },
                attrs: { type: 'button', role: 'tab', 'aria-selected': 'false', tabindex: '-1' },
            },
            [item.icon ? icon(item.icon) : null, el('span', { class: 'maestro-tab-label', text: item.label }), badge],
        );
        node.addEventListener('click', () => choose(item.id));
        return node;
    };

    const groupBlock = (block: Block & { group: string }, index: number): HTMLElement => {
        const headId = `${prefix}-group-${index}`;
        const bodyId = `${headId}-items`;
        const head = el(
            'button',
            {
                class: 'maestro-tab-group-head',
                data: { group: block.group },
                attrs: { type: 'button', id: headId, 'aria-controls': bodyId },
            },
            [
                icon('fa-chevron-down', 'maestro-tab-group-chevron'),
                el('span', { class: 'maestro-tab-group-label', text: block.label }),
                el('span', { class: 'maestro-tab-badge' }),
            ],
        );
        head.addEventListener('click', () => toggle(block.group, !collapsedGroups.has(block.group)));
        const body = el('div', { class: 'maestro-tab-group-items', attrs: { id: bodyId } }, block.items.map(tabButton));
        return el(
            'div',
            {
                class: 'maestro-tab-group',
                data: { group: block.group },
                attrs: { role: 'group', 'aria-labelledby': headId },
            },
            [head, body],
        );
    };

    const render = () => {
        blocks = blocksOf(items);
        list.replaceChildren();
        picker.replaceChildren();
        blocks.forEach((block, index) => {
            if (block.group === null) {
                for (const item of block.items) list.appendChild(tabButton(item));
                for (const item of block.items) {
                    picker.appendChild(el('option', { text: pickerLabel(item), attrs: { value: item.id } }));
                }
                return;
            }
            list.appendChild(groupBlock(block as Block & { group: string }, index));
            picker.appendChild(
                el(
                    'optgroup',
                    { attrs: { label: block.label } },
                    block.items.map((item) => el('option', { text: pickerLabel(item), attrs: { value: item.id } })),
                ),
            );
        });
        mark();
    };

    /** Heading state: collapsed flag, rolled-up badge and «the active tab is inside» while collapsed. */
    const markGroups = () => {
        for (const block of blocks) {
            if (block.group === null) continue;
            const node = groupNodeOf(block.group);
            if (!node) continue;
            const collapsed = collapsedGroups.has(block.group);
            const head = node.querySelector<HTMLButtonElement>('.maestro-tab-group-head');
            const body = node.querySelector<HTMLElement>('.maestro-tab-group-items');
            node.classList.toggle('maestro-collapsed', collapsed);
            node.classList.toggle('maestro-has-active', collapsed && block.items.some((item) => item.id === current));
            if (body) body.hidden = collapsed;
            if (head) {
                head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                const title = options.groupTitle?.(collapsed);
                if (title) head.title = title;
                const total = collapsed ? block.items.reduce((sum, item) => sum + (item.badge ?? 0), 0) : 0;
                const badge = head.querySelector<HTMLElement>('.maestro-tab-badge');
                if (badge) {
                    badge.textContent = total ? String(total) : '';
                    badge.hidden = !total;
                }
            }
        }
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
        markGroups();
    };

    const toggle = (group: string, collapsed: boolean) => {
        if (collapsedGroups.has(group) === collapsed) return;
        if (collapsed) collapsedGroups.add(group);
        else collapsedGroups.delete(group);
        writeCollapsed(options.storageKey, collapsedGroups);
        markGroups();
    };

    /** A tab chosen elsewhere (picker, openPult) inside a collapsed group opens that group. */
    const reveal = (id: string) => {
        const group = blockOf(id)?.group;
        if (group && collapsedGroups.has(group)) toggle(group, false);
    };

    const choose = (id: string) => {
        if (!items.some((item) => item.id === id)) return;
        if (id !== current) reveal(id);
        current = id;
        mark();
        options.onSelect(id);
    };

    /** The next visible tab from `from` in direction `step` (wrapping); tabs of collapsed groups are skipped. */
    const step = (from: number, delta: 1 | -1): TabItem | undefined => {
        for (let offset = 1; offset <= items.length; offset++) {
            const index = (((from + delta * offset) % items.length) + items.length) % items.length;
            const item = items[index];
            if (item && !hidden(item)) return item;
        }
        return undefined;
    };

    list.addEventListener('keydown', (event) => {
        const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(event.key) || !items.length) return;
        event.preventDefault();
        const index = items.findIndex((item) => item.id === current);
        const visible = items.filter((item) => !hidden(item));
        let target: TabItem | undefined;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = step(index < 0 ? -1 : index, 1);
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') target = step(index < 0 ? 0 : index, -1);
        else if (event.key === 'Home') target = visible[0];
        else target = visible[visible.length - 1];
        if (!target) return;
        choose(target.id);
        buttonOf(target.id)?.focus();
    });
    picker.addEventListener('change', () => choose(picker.value));

    const handle: TabsHandle = {
        list,
        picker,
        setItems(next) {
            items = next.map((item) => ({ ...item }));
            render();
        },
        setActive(id) {
            if (!items.some((item) => item.id === id)) return;
            if (id !== current) reveal(id);
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
            markGroups();
        },
        active: () => current,
        setCollapsed: (group, collapsed) => toggle(group, collapsed),
        collapsed: () => [...collapsedGroups].sort(),
    };
    handle.setItems(options.items);
    return handle;
}
