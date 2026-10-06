// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCK_STRINGS, dockModule, NEIGHBOURS, SHORTCUTS } from '../../../src/features/dock';
import { openWindows, windowBody } from '../../helpers/ui-env';
import { desBlock, snapshot, startDock } from './helpers';
import type { DockEnv } from './helpers';

let dock: DockEnv | null = null;

afterEach(async () => {
    await dock?.stop();
    dock?.ui.dispose();
    dock = null;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const body = () => windowBody('maestro')!;
const slot = (id: string) => document.querySelector<HTMLElement>(`.maestro-m32d-slot[data-dock="${id}"]`);
const card = (id: string) => slot(id)?.closest('section') ?? null;
const keepToggle = (id: string) => {
    const input = card(id)?.querySelector<HTMLInputElement>('.maestro-toggle input');
    if (!input) throw new Error(`no toggle in the "${id}" card`);
    return input;
};
const buttonByText = (text: string, root: ParentNode = document) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);
const setToggle = (input: HTMLInputElement, checked: boolean) => {
    input.checked = checked;
    input.dispatchEvent(new Event('change'));
};

async function open(): Promise<DockEnv> {
    dock = await startDock();
    dock.ui.openPult('extensions');
    return dock;
}

describe('dock module', () => {
    it('registers the «Расширения» tab in its group with an icon', async () => {
        dock = await startDock();
        dock.ui.openPult('extensions');
        expect(dockModule).toMatchObject({ id: 'M32d', key: 'dock', stage: 12, enabledByDefault: true });
        const tab = document.querySelector<HTMLElement>('.maestro-window-section[data-tab="extensions"]');
        expect(tab?.textContent).toContain('Расширения');
        expect(tab?.querySelector('.fa-puzzle-piece')).not.toBeNull();
        expect(body().dataset.tab).toBe('extensions');
    });

    it('moves every present neighbour block (the real node, no clone) into its card, in plan order', async () => {
        dock = await startDock();
        const before = snapshot();
        const nodes = {
            ck: document.getElementById('carrot_settings'),
            qvink: document.getElementById('qvink_memory_settings'),
            nai: document.getElementById('naist_panel'),
            desru: document.getElementById('desru-settings'),
            localizer: document.querySelector('.lorebook-localizer-settings'),
            des: desBlock(),
        };
        dock.ui.openPult('extensions');
        const order = [...document.querySelectorAll<HTMLElement>('.maestro-m32d-slot')].map(
            (node) => node.dataset.dock,
        );
        expect(order).toEqual(['ck', 'qvink', 'nai', 'desru', 'localizer', 'des', 'desPortraits']);
        for (const [id, node] of Object.entries(nodes)) {
            expect(slot(id)?.firstElementChild, id).toBe(node);
        }
        for (const id of [
            'carrot_settings',
            'qvink_memory_settings',
            'naist_panel',
            'desru-settings',
            'rpg-extension-enabled',
        ]) {
            expect(document.querySelectorAll(`#${id}`), id).toHaveLength(1);
        }
        expect(snapshot()).not.toEqual(before);
        expect(dock!.api().docked().sort()).toEqual(['ck', 'des', 'desru', 'localizer', 'nai', 'qvink']);
        // The portrait bar stays home by default.
        expect(slot('desPortraits')?.children).toHaveLength(0);
        expect(document.getElementById('dooms-portrait-bar-wrapper')?.parentElement?.id).toBe('form_sheld');
    });

    it('closing the window puts every block back at its exact position', async () => {
        document.body.innerHTML = '';
        dock = await startDock();
        const before = snapshot();
        dock.ui.openPult('extensions');
        dock.ui.closeWindow('maestro');
        expect(snapshot()).toEqual(before);
        expect(dock.api().docked()).toEqual([]);
    });

    it('returns the blocks while the window is still in the document, and when it collapses', async () => {
        dock = await startDock();
        const before = snapshot();
        dock.ui.openPult('extensions');
        const node = document.querySelector<HTMLElement>('.maestro-window[data-window="maestro"]')!;
        const connected: boolean[] = [];
        // Blocks go home through insertBefore on their old parent: record whether the window is still on the page.
        const insert = Node.prototype.insertBefore;
        const spy = vi.spyOn(Node.prototype, 'insertBefore').mockImplementation(function (this: Node, child, ref) {
            connected.push(node.isConnected);
            return insert.call(this, child, ref) as never;
        });
        dock.ui.closeWindow('maestro');
        spy.mockRestore();
        expect(snapshot()).toEqual(before);
        // Every block went home before the window left the page.
        expect(connected.length).toBeGreaterThan(0);
        expect(connected.every(Boolean)).toBe(true);
        // A collapsed window hides its section: the blocks go home; expanding docks them again.
        dock.ui.openPult('extensions');
        expect(dock.api().docked()).toHaveLength(6);
        node.ownerDocument
            .querySelector<HTMLElement>('.maestro-window[data-window="maestro"] .maestro-window-collapse')
            ?.click();
        expect(dock.api().docked()).toEqual([]);
        expect(snapshot()).toEqual(before);
        document.querySelector<HTMLElement>('.maestro-window[data-window="maestro"] .maestro-window-collapse')?.click();
        expect(dock.api().docked()).toHaveLength(6);
    });

    it('switching tabs and re-rendering return the blocks; reopening docks them again', async () => {
        dock = await startDock();
        const before = snapshot();
        const other = { id: 'other', titleKey: 'x', icon: 'fa-star', order: 1, render: () => {} };
        dock.ui.addTab(other);
        dock.ui.openPult('extensions');
        expect(dock.api().docked()).toHaveLength(6);
        dock.ui.openPult('other');
        expect(dock.api().docked()).toEqual([]);
        expect(snapshot()).toEqual(before);
        dock.ui.openPult('extensions');
        expect(dock.api().docked()).toHaveLength(6);
        dock.ui.refresh();
        expect(dock.api().docked()).toHaveLength(6);
        dock.ui.openPult('other');
        expect(snapshot()).toEqual(before);
    });

    it('«Держать в пульте» off keeps the block home and is remembered; on docks it again', async () => {
        dock = await startDock();
        const before = snapshot();
        dock.ui.openPult('extensions');
        setToggle(keepToggle('qvink'), false);
        expect(dock.settings().keep.qvink).toBe(false);
        expect(document.getElementById('qvink_memory_settings')?.parentElement?.id).toBe('extensions_settings2');
        expect(card('qvink')?.textContent).toContain('Блок остаётся в панели расширений.');
        dock.ui.closeWindow('maestro');
        expect(snapshot()).toEqual(before);
        dock.ui.openPult('extensions');
        expect(slot('qvink')?.children).toHaveLength(0);
        expect(keepToggle('qvink').checked).toBe(false);
        setToggle(keepToggle('qvink'), true);
        expect(slot('qvink')?.firstElementChild?.id).toBe('qvink_memory_settings');
        dock.ui.closeWindow('maestro');
        expect(snapshot()).toEqual(before);
    });

    it("never changes the neighbours' settings", async () => {
        await open();
        setToggle(keepToggle('ck'), false);
        dock!.ui.closeWindow('maestro');
        for (const [key, value] of Object.entries(dock!.neighbourSettings)) {
            expect(dock!.env.mock.extensionSettings[key], key).toEqual(value);
        }
    });

    it('keeps Qvink home while its settings are popped out', async () => {
        document.body.innerHTML = '';
        dock = await startDock();
        document.body.insertAdjacentHTML('beforeend', '<div id="qmExtensionPopout" class="draggable"></div>');
        dock.ui.openPult('extensions');
        expect(slot('qvink')?.children).toHaveLength(0);
        expect(card('qvink')?.textContent).toContain('открыты в отдельном окне');
        expect(slot('ck')?.firstElementChild?.id).toBe('carrot_settings');
    });

    it('tolerates a neighbour redrawing its block while it is in the pult', async () => {
        dock = await startDock();
        dock.ui.openPult('extensions');
        const stale = document.getElementById('desru-settings')!;
        const fresh = document.createElement('div');
        fresh.id = 'desru-settings';
        document.getElementById('extensions_settings2')!.appendChild(fresh);
        await flush();
        expect(slot('desru')?.firstElementChild).toBe(fresh);
        expect(stale.isConnected).toBe(false);
        expect(document.querySelectorAll('#desru-settings')).toHaveLength(1);
        dock.ui.closeWindow('maestro');
        expect(document.querySelectorAll('#desru-settings')).toHaveLength(1);
        expect(fresh.parentElement?.id).toBe('extensions_settings2');
    });

    it('shows what happened when a neighbour takes its block back', async () => {
        dock = await startDock();
        dock.ui.openPult('extensions');
        const block = document.getElementById('naist_panel')!;
        document.getElementById('extensions_settings')!.appendChild(block);
        await flush();
        expect(card('nai')?.textContent).toContain('Расширение забрало свой блок');
        dock.ui.closeWindow('maestro');
        expect(block.parentElement?.id).toBe('extensions_settings');
    });

    it('puts a block into the extensions column when its original parent is gone', async () => {
        dock = await startDock();
        const wrapper = document.createElement('div');
        wrapper.id = 'wrapper';
        document.getElementById('extensions_settings2')!.appendChild(wrapper);
        wrapper.appendChild(document.getElementById('desru-settings')!);
        dock.ui.openPult('extensions');
        wrapper.remove();
        dock.ui.closeWindow('maestro');
        expect(document.getElementById('desru-settings')?.parentElement?.id).toBe('extensions_settings2');
    });

    it('module stop, the tab removal and page unload return everything', async () => {
        dock = await startDock();
        const before = snapshot();
        dock.ui.openPult('extensions');
        await dock.stop();
        expect(snapshot()).toEqual(before);
        expect(document.querySelector('.maestro-window-section[data-tab="extensions"]')).toBeNull();

        dock.ui.dispose();
        dock = await startDock();
        const again = snapshot();
        dock.ui.openPult('extensions');
        window.dispatchEvent(new Event('pagehide'));
        expect(snapshot()).toEqual(again);
    });

    it('shows only present neighbours; nothing present → empty state', async () => {
        dock = await startDock({ presence: { qvink: false } });
        document.getElementById('qvink_memory_settings')!.remove();
        dock.ui.openPult('extensions');
        expect(slot('qvink')).toBeNull();
        expect(slot('ck')).not.toBeNull();
        dock.ui.closeWindow('maestro');
        await dock.stop();
        dock.ui.dispose();

        dock = await startDock({
            presence: { des: false, desru: false, ck: false, qvink: false, nai: false, localizer: false },
        });
        document.getElementById('rm_extensions_block')!.remove();
        dock.ui.openPult('extensions');
        expect(body().querySelector('.maestro-empty')?.textContent).toContain('Соседних расширений не нашлось');
    });

    it('a present neighbour without its block on the page shows a note', async () => {
        dock = await startDock();
        document.getElementById('naist_panel')!.remove();
        dock.ui.openPult('extensions');
        expect(card('nai')?.textContent).toContain('Блока настроек нет на странице');
        expect(card('nai')?.textContent).toContain('Подсказки тегов');
    });
});

describe('DES portrait bar', () => {
    it('moves into the tab only when asked and goes back above #send_form', async () => {
        dock = await startDock();
        const before = snapshot();
        const bar = document.getElementById('dooms-portrait-bar-wrapper')!;
        dock.ui.openPult('extensions');
        const toggle = card('desPortraits')!.querySelector<HTMLInputElement>('.maestro-toggle input')!;
        expect(toggle.checked).toBe(false);
        expect(card('desPortraits')?.textContent).toContain('«Панель персонажей в сцене» → «Положение»');
        setToggle(toggle, true);
        expect(dock.settings().portraitBar).toBe(true);
        expect(slot('desPortraits')?.firstElementChild).toBe(bar);
        expect(bar.classList.contains('dooms-pb-position-left')).toBe(true);
        dock.ui.closeWindow('maestro');
        expect(snapshot()).toEqual(before);
        dock.ui.openPult('extensions');
        expect(slot('desPortraits')?.firstElementChild).toBe(bar);
        setToggle(card('desPortraits')!.querySelector<HTMLInputElement>('.maestro-toggle input')!, false);
        expect(snapshot().form).toEqual(before.form);
        expect(dock.settings().portraitBar).toBe(false);
    });

    it('falls back to above #send_form when its parent is gone; returned on stop', async () => {
        dock = await startDock();
        dock.settings().portraitBar = true;
        const form = document.getElementById('form_sheld')!;
        const holder = document.createElement('div');
        form.insertBefore(holder, document.getElementById('send_form'));
        holder.appendChild(document.getElementById('dooms-portrait-bar-wrapper')!);
        dock.ui.openPult('extensions');
        holder.remove();
        await dock.stop();
        expect(document.getElementById('send_form')?.previousElementSibling?.id).toBe('dooms-portrait-bar-wrapper');
    });

    it('no DES → no bar card', async () => {
        dock = await startDock({ presence: { des: false } });
        desBlock()?.remove();
        dock.ui.openPult('extensions');
        expect(card('desPortraits')).toBeNull();
        expect(slot('des')).toBeNull();
    });
});

describe('shortcuts', () => {
    it("lists the windows whose openers are on the page and opens them by the neighbour's own button", async () => {
        dock = await startDock();
        const before = snapshot();
        const clicks: string[] = [];
        for (const id of [
            'dooms-open-settings-btn',
            'dooms-pb-open-roster',
            'naist_img_open_gallery',
            'naist_open_composer',
        ]) {
            document.getElementById(id)!.addEventListener('click', () => {
                clicks.push(id);
                // The opener runs after the window closed and the blocks went home.
                expect(openWindows()).toEqual([]);
                expect(snapshot()).toEqual(before);
            });
        }
        dock.ui.openPult('extensions');
        const section = [...document.querySelectorAll('section')].find(
            (node) => node.querySelector('.maestro-section-title')?.textContent === 'Ярлыки',
        )!;
        const labels = [...section.querySelectorAll('button')].map((node) => node.textContent?.trim());
        expect(labels).toEqual([
            'Редактор памяти Qvink',
            'Галерея NAI Studio',
            'Сцена NAI Studio',
            'Локализатор лорбуков',
            'Настройки DES',
            'Мастерская DES: каталог персонажей',
        ]);
        buttonByText('Настройки DES', section)!.click();
        await flush();
        expect(clicks).toEqual(['dooms-open-settings-btn']);
        dock.ui.openPult('extensions');
        buttonByText('Мастерская DES: каталог персонажей')!.click();
        await flush();
        dock.ui.openPult('extensions');
        buttonByText('Галерея NAI Studio')!.click();
        await flush();
        expect(clicks).toEqual(['dooms-open-settings-btn', 'dooms-pb-open-roster', 'naist_img_open_gallery']);
    });

    it("offers DES's Lore Library and tracker editor once DES loaded its windows, preferring the settings window's roster", async () => {
        dock = await startDock();
        document.body.insertAdjacentHTML(
            'beforeend',
            '<div id="rpg-settings-popup" style="display:none"><button id="rpg-open-lorebook"></button>' +
                '<button id="rpg-open-tracker-editor"></button><button id="rpg-open-character-roster"></button></div>',
        );
        const roster = vi.fn();
        const lore = vi.fn();
        document.getElementById('rpg-open-character-roster')!.addEventListener('click', roster);
        document.getElementById('rpg-open-lorebook')!.addEventListener('click', lore);
        dock.ui.openPult('extensions');
        expect(buttonByText('Библиотека лора DES')).toBeDefined();
        expect(buttonByText('Настройка трекера DES')).toBeDefined();
        buttonByText('Библиотека лора DES')!.click();
        dock.ui.openPult('extensions');
        buttonByText('Мастерская DES: каталог персонажей')!.click();
        await flush();
        expect(lore).toHaveBeenCalledTimes(1);
        expect(roster).toHaveBeenCalledTimes(1);
    });

    it("runs Qvink's own slash command when it is registered", async () => {
        dock = await startDock();
        dock.env.slashCommands['qm-toggle-edit-interface'] = { name: 'qm-toggle-edit-interface' } as never;
        dock.ui.openPult('extensions');
        buttonByText('Редактор памяти Qvink')!.click();
        await flush();
        expect(dock.env.executeSlash).toHaveBeenCalledWith('/qm-toggle-edit-interface', {
            handleExecutionErrors: true,
        });
    });

    it("skips Qvink's disabled button and a hidden roster button", async () => {
        dock = await startDock();
        (document.getElementById('edit_memory_state') as HTMLButtonElement).disabled = true;
        document.getElementById('dooms-portrait-bar-wrapper')!.style.display = 'none';
        dock.ui.openPult('extensions');
        expect(buttonByText('Редактор памяти Qvink')).toBeUndefined();
        expect(buttonByText('Мастерская DES: каталог персонажей')).toBeUndefined();
        expect(buttonByText('Настройки DES')).toBeDefined();
    });

    it("CK's windows open inside its docked block: the drawer opens first, the pult stays", async () => {
        dock = await startDock();
        const toggled = vi.fn((event: Event) => {
            const icon = (event.currentTarget as HTMLElement).querySelector('.inline-drawer-icon')!;
            icon.classList.replace('down', 'up');
        });
        document.querySelector('#carrot_settings .inline-drawer-toggle')!.addEventListener('click', toggled);
        dock.ui.openPult('extensions');
        const actions = card('ck')!.querySelector<HTMLElement>('[data-shortcuts="ck"]')!;
        expect(actions.hidden).toBe(false);
        expect([...actions.querySelectorAll('button')].map((node) => node.textContent?.trim())).toEqual([
            'Менеджер репозиториев',
            'Шаблоны',
            'Менеджер паков',
        ]);
        buttonByText('Менеджер паков', actions)!.click();
        await flush();
        expect(dock.kernel.openPackManager).toHaveBeenCalledTimes(1);
        expect(toggled).toHaveBeenCalledTimes(1);
        expect(openWindows()).toEqual(['maestro']);
        buttonByText('Шаблоны', actions)!.click();
        await flush();
        expect(toggled).toHaveBeenCalledTimes(1);
        expect(dock.kernel.openTemplateManager).toHaveBeenCalledTimes(1);
        // CK's block at home: its windows would open in the closed Extensions panel, so they are not offered.
        setToggle(keepToggle('ck'), false);
        expect(actions.hidden).toBe(true);
        expect(SHORTCUTS.filter((shortcut) => shortcut.mode === 'docked').every((s) => s.neighbour === 'ck')).toBe(
            true,
        );
    });

    it('an opener that vanished meanwhile gives a notice instead of failing silently', async () => {
        dock = await startDock();
        const notice = vi.spyOn(dock.ui, 'notice');
        dock.ui.openPult('extensions');
        const button = buttonByText('Сцена NAI Studio')!;
        document.getElementById('naist_open_composer')!.remove();
        button.click();
        await flush();
        expect(notice).toHaveBeenCalledWith(
            'Не получилось открыть «Сцена NAI Studio»: расширение сейчас не показывает нужную кнопку. Возможно, оно выключено или ещё загружается.',
            {
                level: 'warn',
                urgent: true,
            },
        );
    });
});

describe('dock strings', () => {
    it('every string exists in both languages; every neighbour and shortcut has a label', () => {
        expect(Object.keys(DOCK_STRINGS.ru).sort()).toEqual(Object.keys(DOCK_STRINGS.en).sort());
        for (const neighbour of NEIGHBOURS) expect(DOCK_STRINGS.ru[neighbour.nameKey], neighbour.id).toBeTruthy();
        for (const shortcut of SHORTCUTS) expect(DOCK_STRINGS.ru[shortcut.labelKey], shortcut.id).toBeTruthy();
    });
});
