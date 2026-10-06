// @vitest-environment happy-dom
// Maestro's windows (plan-2 §10): side panels and floating windows instead of the modal pult — docking, detach and
// attach, collapse, close guards, Escape, z-order, drag and resize, the remembered layout, the phone sheet, the gear,
// and custom bodies with their context.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaestroWindowSpec, PultTab, Unsubscribe, WindowContext } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { moduleSettingsSection } from '../../src/ui/components/card';
import { WINDOWS_STORAGE_KEY } from '../../src/ui/windows/layout';
import { buildStDom, installUiEnv, openWindows, sectionIds, windowBody } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';

let env: UiTestEnv;
let ui: UiImpl;

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
            container.append(Object.assign(document.createElement('p'), { textContent: `content ${id}` }));
            return () => {
                result.cleanups++;
            };
        },
        ...extra,
    };
    return result;
}

const win = (id: string) => document.querySelector<HTMLElement>(`.maestro-window[data-window="${id}"]`);
const control = (id: string, name: string) =>
    document.querySelector<HTMLButtonElement>(`.maestro-window[data-window="${id}"] .maestro-window-${name}`)!;
const saved = () => JSON.parse(localStorage.getItem(WINDOWS_STORAGE_KEY) ?? '{}') as Record<string, never>;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const pointer = (target: EventTarget, type: string, x: number, y: number) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));

function newUi(): UiImpl {
    const next = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    next.mount();
    return next;
}

beforeEach(() => {
    buildStDom();
    env = installUiEnv('en');
    env.settings.core().firstRunDone = true;
    env.i18n.register({
        en: {
            'test.a': 'A',
            'test.b': 'B',
            'test.world': 'World tab',
            'test.calendar': 'Calendar',
            'test.custom': 'Custom',
        },
        ru: { 'test.a': 'А', 'test.b': 'Б', 'test.world': 'Мир', 'test.calendar': 'Календарь', 'test.custom': 'Своё' },
    });
    ui = newUi();
});

afterEach(() => {
    ui.dispose();
    vi.unstubAllGlobals();
});

describe('docking', () => {
    it('opens as a right side panel by default; several windows stack on a side', () => {
        ui.addTab(tab('a', 1));
        ui.addTab(tab('world', 1));
        ui.openPult('a');
        ui.openPult('world');
        const right = document.querySelector<HTMLElement>('.maestro-window-side-right')!;
        expect(right.hidden).toBe(false);
        expect([...right.querySelectorAll<HTMLElement>('.maestro-window')].map((node) => node.dataset.window)).toEqual([
            'maestro',
            'world',
        ]);
        // The Maestro window's default width, kept under 45 % of the 1024px test screen.
        expect(right.style.width).toBe('460px');
        expect(document.querySelector<HTMLElement>('.maestro-window-side-left')?.hidden).toBe(true);
        expect(win('world')?.classList.contains('maestro-window-docked')).toBe(true);
        expect(win('world')?.classList.contains('maestro-window-front')).toBe(true);
        expect(win('maestro')?.classList.contains('maestro-window-front')).toBe(false);
    });

    it('moves to the other side, detaches into a floating window and attaches back to its side', () => {
        ui.addTab(tab('world', 1));
        ui.openPult('world');
        control('world', 'swap').click();
        expect(win('world')?.parentElement?.classList.contains('maestro-window-side-left')).toBe(true);
        expect(control('world', 'swap').title).toBe('Move to the right');
        control('world', 'detach').click();
        const node = win('world')!;
        expect(node.classList.contains('maestro-window-float')).toBe(true);
        expect(node.parentElement?.classList.contains('maestro-windows')).toBe(true);
        expect(node.style.width).not.toBe('');
        expect(Number(node.style.zIndex)).toBeGreaterThan(2900);
        expect(control('world', 'detach').hidden).toBe(true);
        expect(control('world', 'attach').hidden).toBe(false);
        // Content survives docking changes.
        expect(windowBody('world')?.textContent).toBe('content world');
        control('world', 'attach').click();
        expect(win('world')?.parentElement?.classList.contains('maestro-window-side-left')).toBe(true);
        expect(node.style.zIndex).toBe('');
        expect(saved().windows).toMatchObject({ world: { dock: 'left', side: 'left', open: true } });
    });

    it('openWindow({ dock }) places the window; left, right and floating windows coexist', () => {
        ui.addTab(tab('a', 1));
        ui.addTab(tab('world', 1));
        ui.addTab(tab('calendar', 2));
        ui.openWindow('maestro', { dock: 'left' });
        ui.openWindow('world', { dock: 'right' });
        ui.addWindow({
            id: 'note',
            titleKey: 'test.custom',
            icon: 'fa-note-sticky',
            order: 5,
            defaultDock: 'float',
            render: (c) => void c.append('note'),
        });
        ui.openWindow('note');
        expect(win('maestro')?.parentElement?.classList.contains('maestro-window-side-left')).toBe(true);
        expect(win('world')?.parentElement?.classList.contains('maestro-window-side-right')).toBe(true);
        expect(win('note')?.classList.contains('maestro-window-float')).toBe(true);
        expect(openWindows().sort()).toEqual(['maestro', 'note', 'world']);
    });

    it('collapses to its title bar: the section is released, and comes back when expanded', () => {
        const a = tab('a', 1);
        ui.addTab(a);
        ui.openPult('a');
        control('maestro', 'collapse').click();
        expect(win('maestro')?.classList.contains('maestro-window-collapsed')).toBe(true);
        expect(a.cleanups).toBe(1);
        expect(windowBody('maestro')?.textContent).toBe('');
        expect(
            document.querySelector('.maestro-window-side-right')?.classList.contains('maestro-window-side-collapsed'),
        ).toBe(true);
        expect(control('maestro', 'collapse').getAttribute('aria-expanded')).toBe('false');
        control('maestro', 'collapse').click();
        expect(a.renders).toBe(2);
        expect(windowBody('maestro')?.textContent).toBe('content a');
        // Opening a collapsed window expands it.
        control('maestro', 'collapse').click();
        ui.openPult('a');
        expect(win('maestro')?.classList.contains('maestro-window-collapsed')).toBe(false);
    });

    it('resizes a side panel by its edge, within limits', () => {
        ui.addTab(tab('a', 1));
        ui.openPult('a');
        const side = document.querySelector<HTMLElement>('.maestro-window-side-right')!;
        const resizer = side.querySelector<HTMLElement>('.maestro-window-resizer')!;
        pointer(resizer, 'pointerdown', 500, 10);
        pointer(document, 'pointermove', 560, 10);
        pointer(document, 'pointerup', 560, 10);
        expect(side.style.width).toBe('400px');
        pointer(resizer, 'pointerdown', 500, 10);
        pointer(document, 'pointermove', 5000, 10);
        pointer(document, 'pointerup', 5000, 10);
        expect(side.style.width).toBe('280px');
        expect(saved().sides).toMatchObject({ right: 280 });
    });
});

describe('floating windows', () => {
    const spec = (extra: Partial<MaestroWindowSpec> = {}): MaestroWindowSpec => ({
        id: 'note',
        titleKey: 'test.custom',
        icon: 'fa-note-sticky',
        order: 5,
        defaultDock: 'float',
        defaultWidth: 400,
        defaultHeight: 300,
        render: (container) => void container.append('note body'),
        ...extra,
    });

    it('drags by the header, resizes by the grip and remembers both', () => {
        ui.addWindow(spec());
        ui.openWindow('note');
        const node = win('note')!;
        const start = { left: parseInt(node.style.left, 10), top: parseInt(node.style.top, 10) };
        expect(node.style.width).toBe('400px');
        expect(node.style.height).toBe('300px');
        const header = node.querySelector<HTMLElement>('.maestro-window-header')!;
        pointer(header, 'pointerdown', 100, 100);
        pointer(document, 'pointermove', 150, 120);
        pointer(document, 'pointerup', 150, 120);
        expect(parseInt(node.style.left, 10)).toBe(start.left + 50);
        expect(parseInt(node.style.top, 10)).toBe(start.top + 20);
        const grip = node.querySelector<HTMLElement>('.maestro-window-grip')!;
        pointer(grip, 'pointerdown', 0, 0);
        pointer(document, 'pointermove', 60, 40);
        pointer(document, 'pointerup', 60, 40);
        expect(node.style.width).toBe('460px');
        expect(node.style.height).toBe('340px');
        expect(saved().windows).toMatchObject({
            note: { dock: 'float', x: start.left + 50, y: start.top + 20, width: 460, height: 340 },
        });
        // A drag that starts on a header button does not move the window.
        pointer(control('note', 'close'), 'pointerdown', 0, 0);
        pointer(document, 'pointermove', 300, 300);
        pointer(document, 'pointerup', 300, 300);
        expect(parseInt(node.style.left, 10)).toBe(start.left + 50);
    });

    it('a click brings a floating window to the front', () => {
        ui.addWindow(spec());
        ui.addWindow(spec({ id: 'other' }));
        ui.openWindow('note');
        ui.openWindow('other');
        const z = (id: string) => Number(win(id)?.style.zIndex);
        expect(z('other')).toBeGreaterThan(z('note'));
        pointer(win('note')!.querySelector('.maestro-window-body')!, 'pointerdown', 1, 1);
        expect(z('note')).toBeGreaterThan(z('other'));
        expect(win('note')?.classList.contains('maestro-window-front')).toBe(true);
        // Both stay under ST's top bar (3005).
        for (let i = 0; i < 80; i++) pointer(win(i % 2 ? 'note' : 'other')!, 'pointerdown', 1, 1);
        expect(Math.max(z('note'), z('other'))).toBeLessThan(3005);
    });

    it('keeps a moved window reachable on screen', () => {
        ui.addWindow(spec());
        ui.openWindow('note');
        const node = win('note')!;
        const header = node.querySelector<HTMLElement>('.maestro-window-header')!;
        pointer(header, 'pointerdown', 0, 0);
        pointer(document, 'pointermove', -5000, -5000);
        pointer(document, 'pointerup', -5000, -5000);
        expect(parseInt(node.style.top, 10)).toBe(0);
        expect(parseInt(node.style.left, 10)).toBeGreaterThanOrEqual(80 - 400);
    });
});

describe('closing', () => {
    it('the × and Escape close a window; Escape does not reach ST', () => {
        const a = tab('a', 1);
        ui.addTab(a);
        ui.openPult('a');
        control('maestro', 'close').click();
        expect(openWindows()).toEqual([]);
        expect(a.cleanups).toBe(1);
        ui.openPult('a');
        const st = vi.fn();
        document.addEventListener('keydown', st);
        windowBody('maestro')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.removeEventListener('keydown', st);
        expect(openWindows()).toEqual([]);
        expect(st).not.toHaveBeenCalled();
        expect(saved().windows).toMatchObject({ maestro: { open: false } });
    });

    it('respects canClose: false keeps the window, a promise decides later', async () => {
        let allow: boolean | Promise<boolean> = false;
        const cleanup = vi.fn();
        ui.addWindow({
            id: 'guarded',
            titleKey: 'test.custom',
            icon: 'fa-lock',
            order: 1,
            render: () => cleanup,
            canClose: () => allow,
        });
        ui.openWindow('guarded');
        control('guarded', 'close').click();
        expect(ui.isWindowOpen('guarded')).toBe(true);
        let resolve: (value: boolean) => void = () => {};
        allow = new Promise<boolean>((done) => {
            resolve = done;
        });
        ui.closeWindow('guarded');
        // A second request while the guard thinks is ignored.
        ui.closeWindow('guarded');
        resolve(true);
        await flush();
        expect(ui.isWindowOpen('guarded')).toBe(false);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('removing a window spec (module off) takes the window down without asking', () => {
        const cleanup = vi.fn();
        const off = ui.addWindow({
            id: 'mod',
            titleKey: 'test.custom',
            icon: 'fa-cube',
            order: 1,
            render: () => cleanup,
            canClose: () => false,
        });
        ui.openWindow('mod');
        off();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(win('mod')).toBeNull();
    });

    it('an unknown window id opens the Maestro window', () => {
        ui.addTab(tab('a', 1));
        ui.openWindow('nope');
        expect(openWindows()).toEqual(['maestro']);
    });
});

describe('custom bodies (WindowContext)', () => {
    it('renders once, gets params, a title and a close; a second open passes new params', () => {
        let context: WindowContext | null = null;
        const seen: Record<string, unknown>[] = [];
        let renders = 0;
        ui.addWindow({
            id: 'tool',
            titleKey: 'test.custom',
            icon: 'fa-toolbox',
            order: 1,
            render: (container, ctx): Unsubscribe => {
                renders++;
                context = ctx;
                container.append('tool');
                const off = ctx.onParams((params) => seen.push(params));
                return off;
            },
        });
        ui.openWindow('tool', { params: { entity: 'anna' } });
        expect(context!.params()).toEqual({ entity: 'anna' });
        context!.setTitle('Tool: Anna');
        expect(win('tool')?.querySelector('.maestro-window-title')?.textContent).toBe('Tool: Anna');
        ui.openWindow('tool', { params: { entity: 'bob' } });
        expect(renders).toBe(1);
        expect(seen).toEqual([{ entity: 'bob' }]);
        // The gear belongs to section windows only.
        expect(control('tool', 'gear').hidden).toBe(true);
        context!.close();
        expect(ui.isWindowOpen('tool')).toBe(false);
    });

    it('a body that throws shows an error state', () => {
        ui.addWindow({
            id: 'broken',
            titleKey: 'test.custom',
            icon: 'fa-bug',
            order: 1,
            render: () => {
                throw new Error('boom');
            },
        });
        ui.openWindow('broken');
        expect(windowBody('broken')?.querySelector('.maestro-empty')).not.toBeNull();
    });
});

describe('the gear (module settings)', () => {
    it("shows the section's own settings, hidden in a window until then", () => {
        ui.addTab(
            tab('calendar', 1, {
                render(container: HTMLElement) {
                    container.append('days', moduleSettingsSection('Settings of the calendar', 'every 3 turns'));
                },
            }),
        );
        ui.openPult('calendar');
        const node = win('world')!;
        expect(node.querySelector('.maestro-module-settings')).not.toBeNull();
        expect(node.classList.contains('maestro-window-settings-on')).toBe(false);
        control('world', 'gear').click();
        expect(node.classList.contains('maestro-window-settings-on')).toBe(true);
        expect(control('world', 'gear').getAttribute('aria-pressed')).toBe('true');
        control('world', 'gear').click();
        expect(node.classList.contains('maestro-window-settings-on')).toBe(false);
    });

    it('a section without its own settings opens the general settings in the Maestro window', () => {
        ui.addTab(tab('world', 1));
        ui.addTab(tab('settings', 90));
        ui.openPult('world');
        control('world', 'gear').click();
        expect(ui.isWindowOpen('maestro')).toBe(true);
        expect(windowBody('maestro')?.dataset.tab).toBe('settings');
    });
});

describe('the remembered layout', () => {
    it('restores open windows with their place, size, collapsed state and section; not the hidden ones', () => {
        ui.addTab(tab('a', 1));
        ui.addTab(tab('b', 2));
        ui.addTab(tab('world', 1));
        ui.addWindow({
            id: 'studio',
            titleKey: 'test.custom',
            icon: 'fa-book',
            order: 9,
            hidden: true,
            render: () => {},
        });
        ui.openPult('b');
        ui.openPult('world');
        control('world', 'detach').click();
        control('world', 'collapse').click();
        ui.openWindow('studio');
        const place = { left: win('world')!.style.left, width: win('world')!.style.width };
        ui.dispose();

        ui = newUi();
        ui.addTab(tab('a', 1));
        ui.addTab(tab('b', 2));
        ui.addTab(tab('world', 1));
        ui.addWindow({
            id: 'studio',
            titleKey: 'test.custom',
            icon: 'fa-book',
            order: 9,
            hidden: true,
            render: () => {},
        });
        expect(openWindows()).toEqual([]);
        ui.restoreWindows();
        expect(openWindows().sort()).toEqual(['maestro', 'world']);
        expect(document.querySelector('.maestro-window-section.maestro-on')?.getAttribute('data-tab')).toBe('b');
        expect(win('world')?.classList.contains('maestro-window-float')).toBe(true);
        expect(win('world')?.classList.contains('maestro-window-collapsed')).toBe(true);
        expect(win('world')?.style.left).toBe(place.left);
        expect(win('world')?.style.width).toBe(place.width);
        // Once per page.
        ui.closeWindow('world');
        ui.restoreWindows();
        expect(openWindows()).toEqual(['maestro']);
    });

    it('a remembered section registered after the restore takes over when it arrives', () => {
        ui.addTab(tab('a', 1));
        ui.addTab(tab('b', 2));
        ui.openPult('b');
        ui.dispose();
        ui = newUi();
        ui.addTab(tab('a', 1));
        ui.restoreWindows();
        expect(windowBody('maestro')?.textContent).toBe('content a');
        ui.addTab(tab('b', 2));
        expect(windowBody('maestro')?.textContent).toBe('content b');
    });

    it('works without localStorage', () => {
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        try {
            ui.dispose();
            ui = newUi();
            ui.addTab(tab('a', 1));
            ui.openPult('a');
            control('maestro', 'detach').click();
            expect(win('maestro')?.classList.contains('maestro-window-float')).toBe(true);
        } finally {
            get.mockRestore();
            set.mockRestore();
        }
    });
});

describe('phones (≤1000px): one full-screen window at a time', () => {
    let narrow = true;
    beforeEach(() => {
        narrow = true;
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: narrow,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }));
    });

    it('shows only the front window, switches by chips, and closePult() frees the chat', () => {
        const a = tab('a', 1);
        const world = tab('world', 1);
        ui.addTab(a);
        ui.addTab(world);
        ui.openPult('a');
        ui.openPult('world');
        expect(win('maestro')?.classList.contains('maestro-window-sheet')).toBe(true);
        expect(win('maestro')?.hidden).toBe(true);
        expect(win('world')?.hidden).toBe(false);
        // The hidden window's section is released.
        expect(a.cleanups).toBe(1);
        // No docking, collapsing or resizing controls on a phone.
        for (const name of ['swap', 'detach', 'attach', 'collapse']) expect(control('world', name).hidden).toBe(true);
        const chips = [...win('world')!.querySelectorAll<HTMLElement>('.maestro-window-chip')];
        expect(chips.map((chip) => chip.dataset.window)).toEqual(['world', 'maestro']);
        chips[1]!.click();
        expect(win('maestro')?.hidden).toBe(false);
        expect(win('world')?.hidden).toBe(true);
        expect(a.renders).toBe(2);
        expect(world.cleanups).toBe(1);
        ui.closePult();
        expect(openWindows()).toEqual(['world']);
        expect(win('world')?.hidden).toBe(false);
    });

    it('goes back to panels when the screen widens', () => {
        ui.addTab(tab('a', 1));
        ui.addTab(tab('world', 1));
        ui.openPult('a');
        ui.openPult('world');
        narrow = false;
        globalThis.dispatchEvent(new Event('resize'));
        expect(win('maestro')?.hidden).toBe(false);
        expect(win('world')?.hidden).toBe(false);
        expect(win('maestro')?.classList.contains('maestro-window-docked')).toBe(true);
        expect(win('world')?.querySelector<HTMLElement>('.maestro-window-switcher')?.hidden).toBe(true);
    });

    it('the Maestro menu opens full width under the top bar', () => {
        document.querySelector<HTMLElement>('#maestro-topbar .maestro-topbar-toggle')?.click();
        expect(document.querySelector('.maestro-menu')?.classList.contains('maestro-menu-sheet')).toBe(true);
    });
});

describe('sections', () => {
    it('lists the window sections with icons and switches on click', () => {
        ui.addTab(tab('world', 1));
        ui.addTab(tab('calendar', 2));
        ui.openWindow('world', { tab: 'calendar' });
        expect(sectionIds('world')).toEqual(['world', 'calendar']);
        expect(windowBody('world')?.textContent).toBe('content calendar');
        document.querySelector<HTMLElement>('.maestro-window-section[data-tab="world"]')?.click();
        expect(windowBody('world')?.textContent).toBe('content world');
        expect(saved().windows).toMatchObject({ world: { tab: 'world' } });
    });
});
