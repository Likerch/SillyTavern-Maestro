// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { tabs } from '../../src/ui/components/tabs';

function setup() {
    const onSelect = vi.fn();
    const handle = tabs({
        label: 'Sections',
        items: [
            { id: 'a', label: 'Alpha', icon: 'fa-star' },
            { id: 'b', label: 'Beta', badge: 3 },
            { id: 'c', label: 'Gamma' },
        ],
        onSelect,
    });
    document.body.replaceChildren(handle.list, handle.picker);
    const buttons = () => [...handle.list.querySelectorAll<HTMLButtonElement>('.maestro-tab')];
    return { handle, onSelect, buttons };
}

describe('tabs component', () => {
    it('renders a tablist and a picker with the same items; first tab active', () => {
        const { handle, buttons } = setup();
        expect(handle.list.getAttribute('role')).toBe('tablist');
        expect(buttons().map((node) => node.dataset.tab)).toEqual(['a', 'b', 'c']);
        expect([...handle.picker.options].map((option) => option.textContent)).toEqual(['Alpha', 'Beta (3)', 'Gamma']);
        expect(handle.active()).toBe('a');
        expect(buttons()[0]?.getAttribute('aria-selected')).toBe('true');
        expect(buttons()[0]?.getAttribute('tabindex')).toBe('0');
        expect(buttons()[1]?.getAttribute('tabindex')).toBe('-1');
    });

    it('shows badges only when non-zero', () => {
        const { handle, buttons } = setup();
        const badgeOf = (index: number) => buttons()[index]?.querySelector<HTMLElement>('.maestro-tab-badge');
        expect(badgeOf(0)?.hidden).toBe(true);
        expect(badgeOf(1)?.hidden).toBe(false);
        expect(badgeOf(1)?.textContent).toBe('3');
        handle.setBadge('b', 0);
        expect(badgeOf(1)?.hidden).toBe(true);
        expect(handle.picker.options[1]?.textContent).toBe('Beta');
        handle.setBadge('a', 12);
        expect(badgeOf(0)?.textContent).toBe('12');
    });

    it('selects by click and keeps the picker in sync', () => {
        const { handle, onSelect, buttons } = setup();
        buttons()[2]?.click();
        expect(onSelect).toHaveBeenCalledWith('c');
        expect(handle.active()).toBe('c');
        expect(handle.picker.value).toBe('c');
    });

    it('selects through the phone picker', () => {
        const { handle, onSelect, buttons } = setup();
        handle.picker.value = 'b';
        handle.picker.dispatchEvent(new Event('change'));
        expect(onSelect).toHaveBeenCalledWith('b');
        expect(buttons()[1]?.classList.contains('maestro-on')).toBe(true);
    });

    it('moves with arrow keys, Home and End (wrapping)', () => {
        const { handle, onSelect } = setup();
        const press = (key: string) => handle.list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        press('ArrowDown');
        expect(handle.active()).toBe('b');
        press('ArrowUp');
        press('ArrowUp');
        expect(handle.active()).toBe('c');
        press('Home');
        expect(handle.active()).toBe('a');
        press('End');
        expect(handle.active()).toBe('c');
        expect(onSelect).toHaveBeenCalledTimes(5);
    });

    it('keeps the active tab when items change, falls back to the first when it disappears', () => {
        const { handle } = setup();
        handle.setActive('b');
        handle.setItems([
            { id: 'b', label: 'Beta' },
            { id: 'd', label: 'Delta' },
        ]);
        expect(handle.active()).toBe('b');
        handle.setItems([{ id: 'd', label: 'Delta' }]);
        expect(handle.active()).toBe('d');
        handle.setActive('missing');
        expect(handle.active()).toBe('d');
    });
});
