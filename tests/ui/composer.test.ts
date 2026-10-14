// @vitest-environment happy-dom
// The Maestro button at the message box (M40): mounted once right after ST's wand in #leftSendForm (next to other
// extensions' icons), hidden while no group has items or when switched off, re-mounted when ST rebuilds the box; the
// registry of quick actions (groups, visibility, submenus with «Назад», errors), the same groups in the Maestro menu,
// «Одна кнопка» (ST's menu, the wand, LoreBook Creator and, on phones, QuickPersona opened from the button), and
// Ui.prompt over ST's input popup.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerGroup, ComposerItem } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { COMPOSER_BUTTON_ID, MERGED_CLASS } from '../../src/ui/views/composer';
import { resetRegistries } from '../../src/ui/views/registries';
import { resetSlashSlots } from '../../src/ui/views/slash-commands';
import { buildStDom, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes } from '../helpers/ui-fakes';

let env: UiTestEnv;
let ui: UiImpl;

const button = () => document.getElementById(COMPOSER_BUTTON_ID);
const menuIds = () =>
    [...document.querySelectorAll<HTMLElement>('.maestro-menu .maestro-menu-item')].map((node) => node.dataset.item);
const menuItem = (id: string) => document.querySelector<HTMLElement>(`.maestro-menu-item[data-item="${id}"]`);
const headings = () => [...document.querySelectorAll('.maestro-menu-heading')].map((node) => node.textContent);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function group(id: string, items: () => ComposerItem[], extra: Partial<ComposerGroup> = {}): ComposerGroup {
    return { id, order: 10, label: () => `Группа ${id}`, items, ...extra };
}

function buildBox(): void {
    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="send_form"><div id="leftSendForm" class="alignContentCenter"><div id="options_button" class="fa-solid fa-bars interactable"></div><div id="extensionsMenuButton" class="fa-solid fa-magic-wand-sparkles interactable"></div><div id="lbc-trigger" class="fa-solid fa-book interactable"></div></div><textarea id="send_textarea"></textarea></div>`,
    );
}

beforeEach(() => {
    resetRegistries();
    resetSlashSlots();
    buildStDom(2);
    buildBox();
    env = installUiEnv('ru');
    env.settings.core().firstRunDone = true;
    // The button alone; «Одна кнопка» has its own block below.
    env.settings.core().composerMerge = false;
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
    ui.registerCoreViews(coreFakes(env));
});

afterEach(() => {
    ui.dispose();
});

describe('the button at the message box', () => {
    it('is one icon right after the wand, styled like ST’s, and hidden while there is nothing to show', () => {
        expect(button()).not.toBeNull();
        expect(button()!.style.display).toBe('none');
        const ids = [...document.querySelectorAll('#leftSendForm > div')].map((node) => node.id);
        expect(ids).toEqual(['options_button', 'extensionsMenuButton', COMPOSER_BUTTON_ID, 'lbc-trigger']);
        expect(button()!.className).toContain('interactable');
        expect(button()!.className).toContain('fa-solid');
        expect(button()!.getAttribute('title')).toBe('Maestro: быстрые действия');
        const off = ui.addComposerAction(group('a', () => [{ id: 'x', label: 'Икс', run: () => {} }]));
        expect(button()!.style.display).toBe('');
        expect(document.querySelectorAll(`#${COMPOSER_BUTTON_ID}`)).toHaveLength(1);
        off();
        expect(button()!.style.display).toBe('none');
    });

    it('hides groups that are not visible or empty and follows their changes', () => {
        let visible = false;
        let notify = () => {};
        ui.addComposerAction(
            group('b', () => [{ id: 'y', label: 'Игрек', run: () => {} }], {
                visible: () => visible,
                onChange: (listener) => {
                    notify = listener;
                    return () => {};
                },
            }),
        );
        ui.addComposerAction(group('empty', () => []));
        expect(button()!.style.display).toBe('none');
        visible = true;
        notify();
        expect(button()!.style.display).toBe('');
        button()!.click();
        expect(headings()).toEqual(['Группа b']);
        expect(menuIds()).toEqual(['b:y']);
    });

    it('can be switched off in the settings and is mounted again when ST rebuilds the box', async () => {
        ui.addComposerAction(group('a', () => [{ id: 'x', label: 'Икс', run: () => {} }]));
        env.settings.core().composerButton = false;
        env.settings.notify('core.composerButton');
        expect(button()).toBeNull();
        env.settings.core().composerButton = true;
        env.settings.notify('core.composerButton');
        expect(button()).not.toBeNull();
        // Another extension rebuilt the box: the next event puts the button back once.
        document.getElementById('leftSendForm')!.innerHTML =
            '<div id="extensionsMenuButton" class="fa-solid fa-magic-wand-sparkles interactable"></div>';
        await env.host.events.emit('CHAT_CHANGED');
        await flush();
        expect(document.querySelectorAll(`#${COMPOSER_BUTTON_ID}`)).toHaveLength(1);
        expect(document.getElementById('extensionsMenuButton')!.nextElementSibling?.id).toBe(COMPOSER_BUTTON_ID);
        ui.dispose();
        expect(button()).toBeNull();
    });

    it('opens the menu, runs items, walks into submenus and back, reports failures', async () => {
        const run = vi.fn();
        ui.addComposerAction(
            group('a', () => [
                { id: 'go', label: 'Сделать', hint: 'подсказка', run },
                {
                    id: 'more',
                    label: 'Ещё',
                    submenu: () => [
                        { id: 'one', label: 'Один', active: true, run },
                        { id: 'bad', label: 'Сломано', run: () => Promise.reject(new Error('упало')) },
                    ],
                },
            ]),
        );
        button()!.click();
        expect(button()!.getAttribute('aria-expanded')).toBe('true');
        expect(menuIds()).toEqual(['a:go', 'a:more']);
        expect(menuItem('a:go')!.querySelector('.maestro-menu-hint')?.textContent).toBe('подсказка');
        expect(menuItem('a:more')!.getAttribute('aria-haspopup')).toBe('menu');
        menuItem('a:more')!.click();
        expect(menuIds()).toEqual(['__back', 'a:more:one', 'a:more:bad']);
        expect(document.querySelector('.maestro-menu-title')?.textContent).toBe('Ещё');
        expect(menuItem('__back')!.textContent).toContain('Назад');
        expect(menuItem('a:more:one')!.classList.contains('maestro-on')).toBe(true);
        menuItem('__back')!.click();
        expect(menuIds()).toEqual(['a:go', 'a:more']);
        menuItem('a:more')!.click();
        menuItem('a:more:one')!.click();
        expect(run).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.maestro-menu')).toBeNull();
        button()!.click();
        menuItem('a:more')!.click();
        menuItem('a:more:bad')!.click();
        await flush();
        expect(env.toastr.error).toHaveBeenCalled();
        // A second click on the button closes the menu.
        button()!.click();
        button()!.click();
        expect(document.querySelector('.maestro-menu')).toBeNull();
    });

    it('lists the same groups in the Maestro menu', () => {
        ui.addComposerAction(group('a', () => [{ id: 'x', label: 'Икс', run: () => {} }], { order: 5 }));
        document.querySelector<HTMLElement>('#maestro-topbar .maestro-topbar-toggle')!.click();
        expect(headings()).toContain('Группа a');
        expect(menuIds()).toContain('a:x');
        expect(menuIds().at(-1)).toBe('settings');
    });
});

describe('one button at the message box', () => {
    const form = () => document.getElementById('leftSendForm')!;
    const merge = (on: boolean) => {
        env.settings.core().composerMerge = on;
        env.settings.notify('core.composerMerge');
    };
    const addPersona = (name: string) =>
        form().insertAdjacentHTML(
            'beforeend',
            `<div id="quickPersona" class="interactable"><img id="quickPersonaImg" title="${name}"></div>`,
        );

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('takes in ST’s menu, the wand and LoreBook Creator: a general menu icon, shown with no Maestro actions', () => {
        merge(true);
        expect(form().classList.contains(MERGED_CLASS)).toBe(true);
        expect(button()!.style.display).toBe('');
        expect(button()!.classList.contains('fa-bars')).toBe(true);
        expect(button()!.classList.contains('fa-masks-theater')).toBe(false);
        expect(button()!.getAttribute('title')).toBe('Меню: SillyTavern, расширения, Maestro');
        ui.addComposerAction(group('a', () => [{ id: 'x', label: 'Икс', run: () => {} }]));
        button()!.click();
        expect(menuIds()).toEqual([
            'merged:options_button',
            'merged:extensionsMenuButton',
            'merged:lbc-trigger',
            'a:x',
        ]);
        expect(menuItem('merged:options_button')!.textContent).toContain('Меню SillyTavern');
        expect(headings()).toEqual(['Группа a']);
    });

    it('opens the icons’ own menus: a click that does not bubble for ST, one that does for LoreBook Creator', () => {
        merge(true);
        const onOptions = vi.fn();
        const onLbc = vi.fn();
        const onDocument = vi.fn();
        document.getElementById('options_button')!.addEventListener('click', onOptions);
        document.addEventListener('click', (event) => {
            onDocument((event.target as HTMLElement).id);
            if ((event.target as HTMLElement).closest('#lbc-trigger')) onLbc();
        });
        button()!.click();
        menuItem('merged:options_button')!.click();
        expect(onOptions).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.maestro-menu')).toBeNull();
        // ST's «a click elsewhere closes the menu» on the document never sees it.
        expect(onDocument).not.toHaveBeenCalledWith('options_button');
        button()!.click();
        menuItem('merged:lbc-trigger')!.click();
        expect(onLbc).toHaveBeenCalledTimes(1);
    });

    it('leaves out icons their owners hide; the persona picker only on phones, with its name', () => {
        merge(true);
        document.getElementById('extensionsMenuButton')!.style.display = 'none';
        addPersona('Кай');
        button()!.click();
        expect(menuIds()).toEqual(['merged:options_button', 'merged:lbc-trigger']);
        button()!.click();
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1000px'), media: query }));
        button()!.click();
        expect(menuIds()).toEqual(['merged:options_button', 'merged:lbc-trigger', 'merged:quickPersona']);
        expect(menuItem('merged:quickPersona')!.querySelector('.maestro-menu-hint')?.textContent).toBe('Кай');
    });

    it('opens above the box on phones with a width and a top only (ST fixes html at zero size there)', () => {
        merge(true);
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1000px'), media: query }));
        vi.stubGlobal('innerWidth', 375);
        vi.stubGlobal('innerHeight', 812);
        button()!.getBoundingClientRect = () => new DOMRect(3, 770, 35, 40);
        button()!.click();
        const menu = document.querySelector<HTMLElement>('.maestro-composer-menu')!;
        expect(menu.classList.contains('maestro-menu-up')).toBe(true);
        expect(menu.style.bottom).toBe('');
        expect(menu.style.right).toBe('');
        expect(menu.style.width).toBe('359px');
        expect(menu.style.maxHeight).toBe('758px');
        expect(parseInt(menu.style.top, 10)).toBeGreaterThanOrEqual(8);
        expect(parseInt(menu.style.top, 10)).toBeLessThan(770);
    });

    it('gives the icons back when switched off, with the button or on its own', () => {
        merge(true);
        merge(false);
        expect(form().classList.contains(MERGED_CLASS)).toBe(false);
        expect(button()!.classList.contains('fa-masks-theater')).toBe(true);
        expect(button()!.style.display).toBe('none');
        merge(true);
        env.settings.core().composerButton = false;
        env.settings.notify('core.composerButton');
        expect(form().classList.contains(MERGED_CLASS)).toBe(false);
        expect(button()).toBeNull();
        env.settings.core().composerButton = true;
        env.settings.notify('core.composerButton');
        expect(form().classList.contains(MERGED_CLASS)).toBe(true);
        ui.dispose();
        expect(form().classList.contains(MERGED_CLASS)).toBe(false);
    });
});

describe('Ui.prompt', () => {
    it('asks through ST’s input popup and trims the answer; cancel or empty is null', async () => {
        env.callGenericPopup.mockResolvedValueOnce('  Вера  ');
        expect(await ui.prompt('Кто?', { value: 'В', hint: 'имя' })).toBe('Вера');
        expect(env.callGenericPopup.mock.calls.at(-1)![1]).toBe(3);
        expect(env.callGenericPopup.mock.calls.at(-1)![2]).toBe('В');
        env.callGenericPopup.mockResolvedValueOnce('   ');
        expect(await ui.prompt('Кто?')).toBeNull();
        env.callGenericPopup.mockResolvedValueOnce(null);
        expect(await ui.prompt('Кто?')).toBeNull();
    });
});
