// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PultTab } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { buildStDom, FakePopup, installUiEnv, openWindows, sectionIds, windowBody } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';

function tab(id: string, order: number, extra: Partial<PultTab> = {}): PultTab & { renders: number; cleanups: number } {
    const result = {
        id,
        titleKey: `test.${id}`,
        icon: 'fa-star',
        order,
        renders: 0,
        cleanups: 0,
        render(container: HTMLElement) {
            result.renders++;
            container.append(
                Object.assign(document.createElement('p'), { textContent: `content ${id} #${result.renders}` }),
            );
            return () => {
                result.cleanups++;
            };
        },
        ...extra,
    };
    return result;
}

let env: UiTestEnv;
let ui: UiImpl;

const tabIds = () => sectionIds('maestro');
const body = () => windowBody('maestro');
const topBadge = () => document.querySelector<HTMLElement>('#maestro-topbar .maestro-topbar-badge');
const menuItems = () =>
    [...document.querySelectorAll<HTMLElement>('.maestro-menu .maestro-menu-item')].map((node) => node.dataset.item);

beforeEach(() => {
    buildStDom();
    env = installUiEnv('en');
    env.i18n.register({
        en: { 'test.a': 'A', 'test.b': 'B', 'test.c': 'C' },
        ru: { 'test.a': 'А', 'test.b': 'Б', 'test.c': 'В' },
    });
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
});

afterEach(() => {
    ui.dispose();
});

describe('entry points', () => {
    it('mounts the top-bar button next to the extensions button, the extensions block and the wand item', () => {
        const top = document.querySelector('#maestro-topbar');
        expect(top?.previousElementSibling?.id).toBe('extensions-settings-button');
        expect(top?.querySelector('.drawer-icon.fa-wand-magic-sparkles')).not.toBeNull();
        expect(document.querySelector('#extensions_settings2 #maestro-ext-settings .inline-drawer')).not.toBeNull();
        expect(document.querySelector('#extensionsMenu #maestro-wand')).not.toBeNull();
        // Still the only Maestro icon in the top bar (plan-2 В18).
        expect(document.querySelectorAll('#top-settings-holder [id^="maestro"]')).toHaveLength(1);
    });

    it('the top-bar icon and the wand open the Maestro menu; the extensions block opens the Maestro window', () => {
        ui.addTab(tab('a', 1));
        const toggle = document.querySelector<HTMLElement>('#maestro-topbar .maestro-topbar-toggle')!;
        toggle.click();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(menuItems()).toContain('window:maestro');
        expect(menuItems()).toContain('settings');
        // A second click closes it.
        toggle.click();
        expect(document.querySelector('.maestro-menu')).toBeNull();
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        document
            .querySelector<HTMLElement>('#maestro-wand [role=button]')
            ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(document.querySelector('.maestro-menu')).not.toBeNull();
        document.querySelector<HTMLElement>('.maestro-menu-item[data-item="window:maestro"]')?.click();
        expect(document.querySelector('.maestro-menu')).toBeNull();
        expect(openWindows()).toEqual(['maestro']);
        ui.closeWindow('maestro');
        document.querySelector<HTMLElement>('#maestro-ext-settings .maestro-ext-open')?.click();
        expect(openWindows()).toEqual(['maestro']);
        expect(FakePopup.open()).toHaveLength(0);
    });

    it('removes everything on dispose', () => {
        ui.addTab(tab('a', 1));
        ui.openPult();
        document.querySelector<HTMLElement>('#maestro-topbar .maestro-topbar-toggle')?.click();
        const off = ui.style('x', '.a{}');
        void off;
        ui.dispose();
        expect(document.querySelector('#maestro-topbar')).toBeNull();
        expect(document.querySelector('#maestro-ext-settings')).toBeNull();
        expect(document.querySelector('#maestro-wand')).toBeNull();
        expect(document.querySelector('style[data-maestro-style]')).toBeNull();
        expect(document.querySelector('.maestro-windows')).toBeNull();
        expect(document.querySelector('.maestro-menu')).toBeNull();
        ui.openPult();
        ui.openWindow('maestro');
        expect(document.querySelector('.maestro-window')).toBeNull();
    });

    it('mounts late containers on APP_READY', async () => {
        ui.dispose();
        document.body.innerHTML = '<div id="top-settings-holder"></div>';
        ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
        env.settings.core().firstRunDone = true;
        ui.mount();
        expect(document.querySelector('#maestro-wand')).toBeNull();
        document.body.insertAdjacentHTML('beforeend', '<div id="extensionsMenu"></div>');
        await env.host.events.emit('APP_READY');
        expect(document.querySelector('#maestro-wand')).not.toBeNull();
    });
});

describe('sections (the old pult tabs)', () => {
    it('sorts sections by order regardless of registration order', () => {
        ui.addTab(tab('c', 30));
        ui.addTab(tab('a', 10));
        ui.addTab(tab('b', 20));
        ui.openPult();
        expect(tabIds()).toEqual(['a', 'b', 'c']);
        expect(document.querySelector('.maestro-window-section.maestro-on')?.getAttribute('data-tab')).toBe('a');
    });

    it('renders lazily: only the active section, and disposes it on switch and close', () => {
        const a = tab('a', 1);
        const b = tab('b', 2);
        ui.addTab(a);
        ui.addTab(b);
        expect(a.renders + b.renders).toBe(0);
        ui.openPult();
        expect([a.renders, b.renders]).toEqual([1, 0]);
        expect(body()?.textContent).toBe('content a #1');
        ui.openPult('b');
        expect([a.cleanups, b.renders]).toEqual([1, 1]);
        expect(body()?.textContent).toBe('content b #1');
        // The strip switches sections too.
        document.querySelector<HTMLElement>('.maestro-window-section[data-tab="a"]')?.click();
        expect([a.renders, b.cleanups]).toEqual([2, 1]);
        ui.closeWindow('maestro');
        expect(a.cleanups).toBe(2);
        expect(openWindows()).toEqual([]);
    });

    it('re-renders the active section on refresh(), not while the user types in it', () => {
        const a = tab('a', 1, {
            render(container: HTMLElement) {
                a.renders++;
                container.append(Object.assign(document.createElement('input'), { type: 'text' }));
                return () => {
                    a.cleanups++;
                };
            },
        });
        ui.addTab(a);
        ui.openPult();
        ui.refresh();
        expect(a.renders).toBe(2);
        expect(a.cleanups).toBe(1);
        body()?.querySelector('input')?.focus();
        ui.refresh();
        expect(a.renders).toBe(2);
    });

    it('closePult() leaves desktop windows open (they do not cover the chat)', () => {
        ui.addTab(tab('a', 1));
        ui.openPult();
        ui.closePult();
        expect(openWindows()).toEqual(['maestro']);
    });

    it('remembers the last section of a window', () => {
        ui.addTab(tab('a', 1));
        ui.addTab(tab('b', 2));
        ui.openPult('b');
        ui.openPult();
        expect(document.querySelectorAll('.maestro-window')).toHaveLength(1);
        ui.closeWindow('maestro');
        ui.openPult();
        expect(document.querySelector('.maestro-window-section.maestro-on')?.getAttribute('data-tab')).toBe('b');
    });

    it('handles sections added and removed while open', () => {
        const removeA = ui.addTab(tab('a', 1));
        ui.openPult();
        ui.addTab(tab('b', 0));
        expect(tabIds()).toEqual(['b', 'a']);
        removeA();
        expect(tabIds()).toEqual(['b']);
        expect(body()?.textContent).toBe('content b #1');
    });

    it('shows an error state when a section fails to render', () => {
        ui.addTab(
            tab('a', 1, {
                render: () => {
                    throw new Error('boom');
                },
            }),
        );
        ui.openPult();
        expect(body()?.querySelector('.maestro-empty')).not.toBeNull();
    });

    it('opens no ST popup: a non-modal window with Maestro classes', () => {
        ui.addTab(tab('a', 1));
        ui.openPult();
        expect(FakePopup.instances).toHaveLength(0);
        const node = document.querySelector<HTMLElement>('.maestro-window')!;
        expect(node.closest('.maestro-windows.maestro-ui')).not.toBeNull();
        expect(node.getAttribute('aria-modal')).toBe('false');
    });
});

describe('badges', () => {
    it('sums section badges into the top-bar badge', () => {
        let count = 2;
        ui.addTab(tab('a', 1, { badge: () => count }));
        ui.addTab(tab('b', 2, { badge: () => 1 }));
        expect(topBadge()?.hidden).toBe(false);
        expect(topBadge()?.textContent).toBe('3');
        count = 0;
        ui.refresh();
        expect(topBadge()?.textContent).toBe('1');
    });

    it('updates section badges in an open window and hides zero', () => {
        let count = 0;
        ui.addTab(tab('a', 1, { badge: () => count }));
        ui.addTab(tab('b', 2));
        ui.openPult();
        const badge = () =>
            document.querySelector<HTMLElement>('.maestro-window-section[data-tab="a"] .maestro-window-section-badge');
        expect(badge()?.hidden).toBe(true);
        expect(topBadge()?.hidden).toBe(true);
        count = 5;
        ui.refresh();
        expect(badge()?.textContent).toBe('5');
        expect(topBadge()?.textContent).toBe('5');
    });

    it('survives a throwing badge', () => {
        ui.addTab(
            tab('a', 1, {
                badge: () => {
                    throw new Error('x');
                },
            }),
        );
        expect(topBadge()?.hidden).toBe(true);
    });
});

describe('style()', () => {
    it('adds, replaces and removes a <style> by id', () => {
        const off = ui.style('one', '.a { color: red; }');
        expect(document.head.querySelectorAll('style[data-maestro-style="one"]')).toHaveLength(1);
        const offAgain = ui.style('one', '.a { color: blue; }');
        const nodes = document.head.querySelectorAll('style[data-maestro-style="one"]');
        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.textContent).toBe('.a { color: blue; }');
        offAgain();
        expect(document.head.querySelector('style[data-maestro-style="one"]')).toBeNull();
        off();
    });
});
