// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PultTab } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { tabs } from '../../src/ui/components/tabs';
import { COLLAPSED_GROUPS_KEY } from '../../src/ui/views/pult';
import { groupOf, MORE_GROUP, PULT_GROUPS, sortTabs, TAB_GROUPS, TOP_GROUP } from '../../src/ui/views/pult-groups';
import { UI_STRINGS } from '../../src/ui/views/strings';
import { buildStDom, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';

function tab(id: string, order: number, extra: Partial<PultTab> = {}): PultTab {
    return {
        id,
        titleKey: `test.${id}`,
        icon: 'fa-star',
        order,
        render(container: HTMLElement) {
            container.textContent = `content ${id}`;
        },
        ...extra,
    };
}

describe('group map', () => {
    it('places every known tab in its plan §7 group', () => {
        const expected: Record<string, string[]> = {
            top: ['overview'],
            turn: ['turn', 'prompt', 'director', 'voices', 'quality', 'architect', 'treasurer'],
            inbox: ['inbox'],
            canon: [
                'canon',
                'living',
                'revision',
                'signals',
                'chronicle',
                'lorePassports',
                'loreStudio',
                'presetStudio',
            ],
            dossier: ['dossier', 'wardrobe', 'bunnymo'],
            world: ['world', 'places', 'relations', 'calendar', 'offscreen', 'knowledge', 'backgrounds'],
            mechanics: ['mechanics'],
            health: ['health', 'doctor', 'guardian', 'rules', 'tasks', 'metrics'],
            journal: ['journal'],
            assistant: ['assistant'],
            extensions: ['extensions'],
            settings: ['settings', 'theme'],
        };
        for (const [group, ids] of Object.entries(expected)) {
            for (const id of ids) expect(groupOf({ id }), id).toBe(group);
        }
        expect(Object.keys(TAB_GROUPS).sort()).toEqual(Object.values(expected).flat().sort());
        expect(groupOf({ id: 'somethingNew' })).toBe(MORE_GROUP);
    });

    it("prefers the tab's own known group; an unknown group falls back to the map", () => {
        expect(groupOf({ id: 'somethingNew', group: 'world' })).toBe('world');
        expect(groupOf({ id: 'canon', group: 'health' })).toBe('health');
        expect(groupOf({ id: 'canon', group: 'nonsense' })).toBe('canon');
        expect(groupOf({ id: 'x', group: 'nonsense' })).toBe(MORE_GROUP);
    });

    it('sorts by group, then order, then id; «Ещё» comes right before the settings', () => {
        const sorted = sortTabs([
            tab('settings', 90),
            tab('zzz', 1),
            tab('journal', 80),
            tab('inbox', 30),
            tab('prompt', 21),
            tab('turn', 20),
            tab('overview', 10),
            tab('aaa', 1),
        ]);
        expect(sorted.map((item) => item.id)).toEqual([
            'overview',
            'turn',
            'prompt',
            'inbox',
            'journal',
            'aaa',
            'zzz',
            'settings',
        ]);
        expect(PULT_GROUPS[0]).toBe(TOP_GROUP);
        expect(PULT_GROUPS.at(-1)).toBe('settings');
    });

    it('every group has a heading in both languages', () => {
        for (const group of PULT_GROUPS.filter((id) => id !== TOP_GROUP)) {
            expect(UI_STRINGS.en[`ui.group.${group}`], group).toBeTruthy();
            expect(UI_STRINGS.ru[`ui.group.${group}`], group).toBeTruthy();
        }
    });
});

describe('tabs component with groups', () => {
    const items = () => [
        { id: 'o', label: 'Overview' },
        { id: 'a', label: 'A', group: 'g1', groupLabel: 'Group 1', badge: 2 },
        { id: 'b', label: 'B', group: 'g1', groupLabel: 'Group 1', badge: 3 },
        { id: 'c', label: 'C', group: 'g2', groupLabel: 'Group 2' },
        { id: 'd', label: 'D', group: 'g3', groupLabel: 'Group 3' },
        { id: 'e', label: 'E', group: 'g3', groupLabel: 'Group 3' },
    ];

    beforeEach(() => localStorage.clear());

    function setup(storageKey?: string) {
        const onSelect = vi.fn();
        const handle = tabs({ label: 'Sections', items: items(), onSelect, storageKey, groupTitle: (c) => `t${+c}` });
        document.body.replaceChildren(handle.list, handle.picker);
        const head = (group: string) =>
            handle.list.querySelector<HTMLButtonElement>(
                `.maestro-tab-group[data-group="${group}"] .maestro-tab-group-head`,
            );
        const groupNode = (group: string) =>
            handle.list.querySelector<HTMLElement>(`.maestro-tab-group[data-group="${group}"]`);
        return { handle, onSelect, head, groupNode };
    }

    it('draws headings for groups of two or more, plain tabs otherwise; the picker uses optgroups', () => {
        const { handle } = setup();
        const children = [...handle.list.children].map((node) =>
            node.classList.contains('maestro-tab-group')
                ? `group:${(node as HTMLElement).dataset.group}`
                : `tab:${(node as HTMLElement).dataset.tab}`,
        );
        expect(children).toEqual(['tab:o', 'group:g1', 'tab:c', 'group:g3']);
        expect([...handle.list.querySelectorAll('.maestro-tab-group-label')].map((node) => node.textContent)).toEqual([
            'Group 1',
            'Group 3',
        ]);
        expect([...handle.list.querySelectorAll<HTMLElement>('.maestro-tab')].map((node) => node.dataset.tab)).toEqual([
            'o',
            'a',
            'b',
            'c',
            'd',
            'e',
        ]);
        const picker = [...handle.picker.children].map((node) =>
            node.tagName === 'OPTGROUP'
                ? `${(node as HTMLOptGroupElement).label}[${[...node.children].map((option) => (option as HTMLOptionElement).value).join(',')}]`
                : (node as HTMLOptionElement).value,
        );
        expect(picker).toEqual(['o', 'Group 1[a,b]', 'c', 'Group 3[d,e]']);
        expect(handle.picker.querySelector('optgroup option')?.textContent).toBe('A (2)');
    });

    it('collapses a group, rolls its badges up into the heading and remembers it', () => {
        const { handle, head, groupNode } = setup(COLLAPSED_GROUPS_KEY);
        const headBadge = () => head('g1')?.querySelector<HTMLElement>('.maestro-tab-badge');
        expect(head('g1')?.getAttribute('aria-expanded')).toBe('true');
        expect(headBadge()?.hidden).toBe(true);
        expect(head('g1')?.title).toBe('t0');
        head('g1')?.click();
        expect(head('g1')?.getAttribute('aria-expanded')).toBe('false');
        expect(head('g1')?.title).toBe('t1');
        expect(groupNode('g1')?.classList.contains('maestro-collapsed')).toBe(true);
        expect(groupNode('g1')?.querySelector<HTMLElement>('.maestro-tab-group-items')?.hidden).toBe(true);
        expect(headBadge()?.hidden).toBe(false);
        expect(headBadge()?.textContent).toBe('5');
        handle.setBadge('b', 10);
        expect(headBadge()?.textContent).toBe('12');
        expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]')).toEqual(['g1']);
        expect(handle.collapsed()).toEqual(['g1']);

        const again = setup(COLLAPSED_GROUPS_KEY);
        expect(again.handle.collapsed()).toEqual(['g1']);
        expect(again.groupNode('g1')?.classList.contains('maestro-collapsed')).toBe(true);
        again.head('g1')?.click();
        expect(again.handle.collapsed()).toEqual([]);
        expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]')).toEqual([]);
    });

    it('arrow keys skip the tabs of a collapsed group; Home and End pick visible tabs', () => {
        const { handle, head } = setup();
        head('g1')?.click();
        head('g3')?.click();
        const press = (key: string) => handle.list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        expect(handle.active()).toBe('o');
        press('ArrowDown');
        expect(handle.active()).toBe('c');
        press('ArrowDown');
        expect(handle.active()).toBe('o');
        press('ArrowUp');
        expect(handle.active()).toBe('c');
        press('End');
        expect(handle.active()).toBe('c');
        press('Home');
        expect(handle.active()).toBe('o');
        expect(document.activeElement).toBe(handle.list.querySelector('.maestro-tab[data-tab="o"]'));
    });

    it('choosing a tab of a collapsed group opens the group; the collapsed active group is marked', () => {
        const { handle, head, groupNode, onSelect } = setup();
        handle.setActive('a');
        head('g1')?.click();
        expect(groupNode('g1')?.classList.contains('maestro-has-active')).toBe(true);
        handle.setActive('a');
        expect(handle.collapsed()).toEqual(['g1']);
        handle.picker.value = 'b';
        handle.picker.dispatchEvent(new Event('change'));
        expect(onSelect).toHaveBeenCalledWith('b');
        expect(handle.collapsed()).toEqual([]);
        head('g3')?.click();
        handle.setActive('e');
        expect(handle.collapsed()).toEqual([]);
    });

    it('works when localStorage throws', () => {
        const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        try {
            const { handle, head } = setup('k');
            expect(handle.collapsed()).toEqual([]);
            head('g1')?.click();
            expect(handle.collapsed()).toEqual(['g1']);
        } finally {
            spy.mockRestore();
            set.mockRestore();
        }
    });
});

describe('grouped pult', () => {
    let env: UiTestEnv;
    let ui: UiImpl;

    beforeEach(() => {
        localStorage.clear();
        buildStDom();
        env = installUiEnv('ru');
        env.i18n.register({
            en: {},
            ru: {
                'test.overview': 'Обзор',
                'test.turn': 'Журнал лора',
                'test.prompt': 'Промпт',
                'test.inbox': 'Входящие',
                'test.canon': 'Канон',
                'test.living': 'Живой канон',
                'test.extensions': 'Расширения',
                'test.settings': 'Настройки',
                'test.custom': 'Своё',
            },
        });
        ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
        ui.mount();
    });

    afterEach(() => ui.dispose());

    const heads = () => [...document.querySelectorAll('.maestro-tab-group-label')].map((node) => node.textContent);
    const tabIds = () => [...document.querySelectorAll<HTMLElement>('.maestro-tab')].map((node) => node.dataset.tab);
    const head = (group: string) =>
        document.querySelector<HTMLButtonElement>(`.maestro-tab-group[data-group="${group}"] .maestro-tab-group-head`);

    function register(): { inbox: number } {
        const counts = { inbox: 2 };
        for (const item of [
            tab('settings', 90),
            tab('custom', 5),
            tab('living', 50, { badge: () => 1 }),
            tab('canon', 35, { badge: () => 4 }),
            tab('extensions', 85, { group: 'extensions' }),
            tab('inbox', 30, { badge: () => counts.inbox }),
            tab('prompt', 21),
            tab('turn', 20),
            tab('overview', 10),
        ]) {
            ui.addTab(item);
        }
        return counts;
    }

    it('shows group headings in plan order with tabs under them', () => {
        register();
        ui.openPult();
        expect(tabIds()).toEqual([
            'overview',
            'turn',
            'prompt',
            'inbox',
            'canon',
            'living',
            'extensions',
            'custom',
            'settings',
        ]);
        expect(heads()).toEqual(['Ход', 'Канон']);
        expect(document.querySelector('.maestro-tab.maestro-on')?.getAttribute('data-tab')).toBe('overview');
        const picker = document.querySelector<HTMLSelectElement>('.maestro-tabs-picker');
        expect([...(picker?.querySelectorAll('optgroup') ?? [])].map((node) => node.label)).toEqual(['Ход', 'Канон']);
    });

    it('collapsing survives reopening the pult; badges roll up and still reach the top bar', async () => {
        const counts = register();
        ui.openPult();
        head('canon')?.click();
        expect(head('canon')?.querySelector('.maestro-tab-badge')?.textContent).toBe('5');
        ui.closePult();
        ui.openPult();
        expect(head('canon')?.getAttribute('aria-expanded')).toBe('false');
        expect(document.querySelector('#maestro-topbar .maestro-topbar-badge')?.textContent).toBe('7');
        counts.inbox = 0;
        ui.refresh();
        expect(document.querySelector('#maestro-topbar .maestro-topbar-badge')?.textContent).toBe('5');
        ui.openPult('living');
        expect(head('canon')?.getAttribute('aria-expanded')).toBe('true');
        expect(document.querySelector('.maestro-pult-body')?.textContent).toBe('content living');
    });
});
