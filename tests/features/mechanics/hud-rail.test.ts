// @vitest-environment happy-dom
// M25 HUD: the rail and the HUD's own switches (release 1.25). Without the room beside the chat a slim tab at the chat's
// edge opens the panel's content as a flyout over the chat's edge, headed by why («Закреплена левая панель
// SillyTavern», «Чат слишком широкий…») and the other side when it has the room; a click elsewhere, Escape or the tab
// again closes it. On a desktop the HUD's header carries a placement menu («Над чатом / Слева от чата / Справа от
// чата») and, beside the chat, the view switch; both write the module's settings. Phones never get the switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUD_ID, MechanicsHud } from '../../../src/features/mechanics/hud';
import { RAIL_GAP, RAIL_WIDTH, SIDE_VIEWS } from '../../../src/features/mechanics/hud-place';
import { FLYOUT_CLASS, RAIL_CLASS, SIDE_CLASS } from '../../../src/features/mechanics/hud-side';
import { createPlayEnv, settlePlay } from './helpers-play';
import type { PlayEnv } from './helpers-play';

type Box = { left: number; top: number; width: number; height: number };

function boxed<T extends HTMLElement>(node: T, box: Box): T {
    node.getBoundingClientRect = () =>
        ({
            ...box,
            x: box.left,
            y: box.top,
            right: box.left + box.width,
            bottom: box.top + box.height,
            toJSON: () => box,
        }) as DOMRect;
    return node;
}

/** ST at 1600×1000 with the chat column at `left`…`left + width`. */
function page(chat: { left: number; width: number } = { left: 400, width: 800 }) {
    const sheld = boxed(document.createElement('div'), { left: chat.left, top: 40, width: chat.width, height: 860 });
    sheld.id = 'sheld';
    const left = document.createElement('div');
    left.id = 'left-nav-panel';
    left.className = 'drawer-content fillLeft closedDrawer';
    const right = document.createElement('div');
    right.id = 'right-nav-panel';
    right.className = 'drawer-content fillRight closedDrawer';
    document.body.append(sheld, left, right);
    return { sheld, left, right };
}

let env: PlayEnv;
let hud: MechanicsHud | null = null;

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.stubGlobal('innerWidth', 1600);
    vi.stubGlobal('innerHeight', 1000);
});

afterEach(() => {
    hud?.dispose();
    hud = null;
    env?.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

async function setup(placement: 'chat' | 'left' | 'right', locale: 'ru' | 'en' = 'ru'): Promise<void> {
    env = await createPlayEnv({ locale });
    env.settings.hudPlacement = placement;
    hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
    hud.install();
    await settlePlay(env);
}

const node = () => document.getElementById(HUD_ID)!;
const tab = () => node().querySelector<HTMLButtonElement>('.maestro-m25-hud-rail-tab')!;
const flyout = () => node().querySelector<HTMLElement>(`.${FLYOUT_CLASS}`);

describe('the rail', () => {
    it('stands over the chat’s edge while ST’s left drawer is pinned and opens the panel with the way out', async () => {
        const { left } = page();
        left.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        await setup('left');
        expect(hud!.layoutNow()).toMatchObject({ mode: 'rail', side: 'left', reason: 'drawer', outside: false });
        expect(node().classList.contains(RAIL_CLASS)).toBe(true);
        expect(node().classList.contains(SIDE_CLASS)).toBe(false);
        expect(node().dataset.layout).toBe('rail');
        expect(node().style.left).toBe('400px');
        expect(node().style.width).toBe(`${RAIL_WIDTH}px`);
        expect(tab().getAttribute('aria-expanded')).toBe('false');
        expect(tab().textContent).toContain('Механики');
        expect(tab().getAttribute('aria-label')).toBe('Показать механики');
        expect(flyout()).toBeNull();
        tab().click();
        expect(tab().getAttribute('aria-expanded')).toBe('true');
        const open = flyout()!;
        // Beside the tab, over the chat: placed relative to the tab.
        expect(open.style.left).toBe(`${RAIL_WIDTH + RAIL_GAP}px`);
        expect(open.style.top).toBe('0px');
        expect(open.style.width).toBe(`${SIDE_VIEWS.compact.width}px`);
        const reason = open.querySelector<HTMLElement>('.maestro-m25-hud-reason')!;
        expect(reason.textContent).toContain('Закреплена левая панель SillyTavern');
        // The same content as the panel: the compact view with its header.
        expect(open.querySelector('.maestro-m25-hud-side-holder[data-holder="Алекс"]')?.textContent).toContain(
            '80/100',
        );
        expect(open.querySelector('.maestro-m25-hud-view')).not.toBeNull();
        expect(open.querySelector('.maestro-m25-hud-place')).not.toBeNull();
        // The right side has the room: one tap moves the HUD there.
        const way = reason.querySelector<HTMLButtonElement>('.maestro-m25-hud-switch')!;
        expect(way.textContent).toBe('Показать справа');
        way.click();
        expect(env.settings.hudPlacement).toBe('right');
        expect(env.notified).toContain('modules.mechanics.hudPlacement');
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', side: 'right' });
        expect(node().classList.contains(SIDE_CLASS)).toBe(true);
    });

    it('says the chat is too wide, outside the chat when the gap holds the tab, and offers no side without room', async () => {
        page({ left: 60, width: 1480 });
        await setup('right');
        expect(hud!.layoutNow()).toMatchObject({ mode: 'rail', side: 'right', reason: 'room', outside: true });
        expect(node().style.left).toBe(`${1540 + RAIL_GAP}px`);
        tab().click();
        const open = flyout()!;
        expect(open.querySelector('.maestro-m25-hud-reason')?.textContent).toBe(
            'Чат слишком широкий: уменьши ширину чата в настройках SillyTavern или выбери другую сторону',
        );
        expect(open.querySelector('.maestro-m25-hud-switch')).toBeNull();
        // Opening leftwards from the tab, over the chat's right edge.
        expect(open.style.left).toBe(`${-RAIL_GAP - SIDE_VIEWS.compact.width}px`);
    });

    it('closes on a click elsewhere, on Escape and on the tab again', async () => {
        const { left } = page();
        left.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        await setup('left');
        tab().click();
        expect(flyout()).not.toBeNull();
        // A click inside keeps it.
        flyout()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(flyout()).not.toBeNull();
        document.getElementById('sheld')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(flyout()).toBeNull();
        tab().click();
        tab().focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(flyout()).toBeNull();
        expect(document.activeElement).toBe(tab());
        tab().click();
        expect(flyout()).not.toBeNull();
        tab().click();
        expect(flyout()).toBeNull();
        // Nothing listens once closed: Escape elsewhere is not taken.
        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(escape);
        expect(escape.defaultPrevented).toBe(false);
    });

    it('closes the menu first, then the flyout, one Escape at a time', async () => {
        const { left } = page();
        left.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        await setup('left');
        tab().click();
        flyout()!.querySelector<HTMLButtonElement>('.maestro-m25-hud-place')!.click();
        expect(document.activeElement?.getAttribute('data-placement')).toBe('left');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(node().querySelector('.maestro-m25-hud-place-menu')).toBeNull();
        expect(flyout()).not.toBeNull();
        expect(document.activeElement?.classList.contains('maestro-m25-hud-place')).toBe(true);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(flyout()).toBeNull();
    });
});

describe('the HUD’s own switches', () => {
    it('moves the HUD from over the chat to the side by its placement menu', async () => {
        page();
        await setup('chat');
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'setting' });
        const place = node().querySelector<HTMLButtonElement>('.maestro-m25-hud-place')!;
        expect(place.getAttribute('title')).toBe('Где показывать механики');
        expect(place.getAttribute('aria-haspopup')).toBe('menu');
        expect(place.getAttribute('aria-expanded')).toBe('false');
        place.click();
        const menu = node().querySelector<HTMLElement>('.maestro-m25-hud-place-menu')!;
        expect(menu.getAttribute('role')).toBe('menu');
        const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        expect(
            items.map((item) => [item.dataset.placement, item.textContent, item.getAttribute('aria-checked')]),
        ).toEqual([
            ['chat', 'Над чатом', 'true'],
            ['left', 'Слева от чата', 'false'],
            ['right', 'Справа от чата', 'false'],
        ]);
        expect(node().querySelector('.maestro-m25-hud-place')?.getAttribute('aria-expanded')).toBe('true');
        // The arrow keys move between the choices.
        expect(document.activeElement).toBe(items[0]);
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(items[1]);
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        expect(document.activeElement).toBe(items[2]);
        items[2]!.click();
        expect(env.settings.hudPlacement).toBe('right');
        expect(env.notified).toContain('modules.mechanics.hudPlacement');
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', side: 'right' });
        expect(node().querySelector('.maestro-m25-hud-place-menu')).toBeNull();
        // Back over the chat from the panel's header.
        node().querySelector<HTMLButtonElement>('.maestro-m25-hud-place')!.click();
        node().querySelector<HTMLButtonElement>('[data-placement="chat"]')!.click();
        expect(env.settings.hudPlacement).toBe('chat');
        expect(hud!.layoutNow().mode).toBe('chat');
        expect(node().querySelector('.maestro-m25-hud-grip')).not.toBeNull();
    });

    it('closes the menu on a click elsewhere without changing anything', async () => {
        page();
        await setup('chat');
        node().querySelector<HTMLButtonElement>('.maestro-m25-hud-place')!.click();
        expect(node().querySelector('.maestro-m25-hud-place-menu')).not.toBeNull();
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(node().querySelector('.maestro-m25-hud-place-menu')).toBeNull();
        expect(env.settings.hudPlacement).toBe('chat');
    });

    it('switches the side view from the panel’s header', async () => {
        page();
        await setup('left');
        const toggle = node().querySelector<HTMLButtonElement>('.maestro-m25-hud-view')!;
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(toggle.getAttribute('title')).toBe('Подробно: все персонажи сцены');
        expect(node().querySelector('.maestro-m25-hud-side-holder[data-holder="Kai"]')).toBeNull();
        toggle.click();
        expect(env.settings.hudSideView).toBe('full');
        expect(env.notified).toContain('modules.mechanics.hudSideView');
        expect(node().querySelector('.maestro-m25-hud-view')?.getAttribute('aria-pressed')).toBe('true');
        expect(node().querySelector('.maestro-m25-hud-side-holder[data-holder="Kai"]')).not.toBeNull();
        expect(hud!.layoutNow()).toMatchObject({ width: SIDE_VIEWS.full.width });
        // Over the chat there is no view to switch.
        env.settings.hudPlacement = 'chat';
        env.app.settings.notify('modules.mechanics.hudPlacement');
        await settlePlay(env);
        expect(node().querySelector('.maestro-m25-hud-view')).toBeNull();
    });

    it('has no placement switch on a phone', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1000px'), media: query }));
        page();
        await setup('left');
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'phone' });
        expect(node().querySelector('.maestro-m25-hud-place')).toBeNull();
        expect(node().querySelector('.maestro-m25-hud-view')).toBeNull();
    });

    it('speaks English in English', async () => {
        const { left } = page();
        left.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        await setup('left', 'en');
        tab().click();
        expect(flyout()!.querySelector('.maestro-m25-hud-reason')?.textContent).toContain(
            'SillyTavern’s left panel is pinned',
        );
        flyout()!.querySelector<HTMLButtonElement>('.maestro-m25-hud-place')!.click();
        expect([...node().querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
            'Over the chat',
            'Left of the chat',
            'Right of the chat',
        ]);
    });
});
