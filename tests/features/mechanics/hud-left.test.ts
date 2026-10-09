// @vitest-environment happy-dom
// M25 HUD «Слева от чата» (hud-place.ts, hud-side.ts): on a wide screen a fuller panel in the free space left of ST's
// chat column — every character of the scene with every value the HUD may show, conditions and items, the fight —
// beside a Maestro window or DES's portrait panel at the left; over the chat as usual on a phone, in a narrow window,
// while ST's left drawer is open or pinned, or without room, the saved setting unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUD_ID, MechanicsHud } from '../../../src/features/mechanics/hud';
import {
    SIDE_GAP,
    SIDE_MAX_WIDTH,
    SIDE_MIN_VIEWPORT,
    SIDE_MIN_WIDTH,
    leftDrawerOpen,
    measureSideRoom,
    resolveHudLayout,
    takenLeft,
} from '../../../src/features/mechanics/hud-place';
import type { SideRoom } from '../../../src/features/mechanics/hud-place';
import { SIDE_CLASS } from '../../../src/features/mechanics/hud-side';
import { createPlayEnv, feelingsDef, settlePlay, vitalsDef } from './helpers-play';
import type { PlayEnv } from './helpers-play';

type Box = { left: number; top: number; width: number; height: number };

/** Gives a node a layout box (happy-dom lays nothing out). */
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

function page(): { sheld: HTMLElement; drawer: HTMLElement } {
    // ST at 1600×1000: the top bar 40px, the chat column 50vw in the middle.
    const sheld = boxed(document.createElement('div'), { left: 400, top: 40, width: 800, height: 860 });
    sheld.id = 'sheld';
    const drawer = document.createElement('div');
    drawer.id = 'left-nav-panel';
    drawer.className = 'drawer-content fillLeft closedDrawer';
    document.body.append(sheld, drawer);
    return { sheld, drawer };
}

const wide: SideRoom = {
    viewportWidth: 1920,
    viewportHeight: 1080,
    phone: false,
    chat: { left: 480, top: 41, bottom: 1080 },
    drawer: false,
    taken: 0,
};

describe('where the mechanics go', () => {
    it('stays over the chat unless «left» is chosen', () => {
        expect(resolveHudLayout('chat', wide)).toEqual({ mode: 'chat', reason: 'setting' });
        expect(resolveHudLayout(undefined, wide)).toEqual({ mode: 'chat', reason: 'setting' });
    });

    it('goes left of the chat on a wide screen, as wide as the free space allows, hugging the chat', () => {
        expect(resolveHudLayout('left', wide)).toEqual({
            mode: 'side',
            left: 480 - SIDE_GAP - SIDE_MAX_WIDTH,
            top: 41 + SIDE_GAP,
            width: SIDE_MAX_WIDTH,
            maxHeight: 1080 - SIDE_GAP - (41 + SIDE_GAP),
            beside: false,
        });
        // 1200px: the chat at 50vw leaves 300px; the panel takes what is left between the gaps.
        const narrowest = resolveHudLayout('left', {
            ...wide,
            viewportWidth: SIDE_MIN_VIEWPORT,
            chat: { left: 300, top: 41, bottom: 800 },
        });
        expect(narrowest).toMatchObject({ mode: 'side', width: 300 - SIDE_GAP * 2, left: SIDE_GAP });
    });

    it('falls back over the chat on a phone, in a narrow window, with ST’s left drawer open or without room', () => {
        expect(resolveHudLayout('left', { ...wide, phone: true })).toEqual({ mode: 'chat', reason: 'phone' });
        expect(resolveHudLayout('left', { ...wide, viewportWidth: SIDE_MIN_VIEWPORT - 1 })).toEqual({
            mode: 'chat',
            reason: 'narrow',
        });
        expect(resolveHudLayout('left', { ...wide, drawer: true })).toEqual({ mode: 'chat', reason: 'drawer' });
        expect(resolveHudLayout('left', { ...wide, chat: null })).toEqual({ mode: 'chat', reason: 'room' });
        // A chat column moved to the left (ST's movable UI) leaves too little.
        expect(
            resolveHudLayout('left', {
                ...wide,
                chat: { left: SIDE_MIN_WIDTH + SIDE_GAP * 2 - 1, top: 0, bottom: 900 },
            }),
        ).toEqual({ mode: 'chat', reason: 'room' });
    });

    it('stands to the right of a panel already at the left (DES portraits, a Maestro window), else over the chat', () => {
        expect(resolveHudLayout('left', { ...wide, taken: 154 })).toMatchObject({
            mode: 'side',
            width: 480 - 154 - SIDE_GAP * 2,
            left: 154 + SIDE_GAP,
            beside: true,
        });
        expect(resolveHudLayout('left', { ...wide, taken: 300 })).toEqual({ mode: 'chat', reason: 'room' });
    });
});

describe('reading the page', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('knows ST’s left drawer open or pinned open', () => {
        const { drawer } = page();
        expect(leftDrawerOpen(document)).toBe(false);
        drawer.className = 'drawer-content fillLeft openDrawer';
        expect(leftDrawerOpen(document)).toBe(true);
        drawer.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        expect(leftDrawerOpen(document)).toBe(true);
        // Pinned but closed by its icon: the gap is free.
        drawer.className = 'drawer-content fillLeft pinnedOpen closedDrawer';
        expect(leftDrawerOpen(document)).toBe(false);
    });

    it('finds DES’s left portrait panel and Maestro’s left side, not the bar held in the dock’s tab', () => {
        page();
        expect(takenLeft(document, 400)).toBe(0);
        const des = boxed(document.createElement('div'), { left: 0, top: 300, width: 154, height: 400 });
        des.id = 'dooms-portrait-bar-wrapper';
        des.className = 'dooms-pb-position-left';
        document.body.append(des);
        expect(takenLeft(document, 400)).toBe(154);
        const side = boxed(document.createElement('div'), { left: 0, top: 40, width: 200, height: 960 });
        side.className = 'maestro-window-side maestro-window-side-left';
        document.body.append(side);
        expect(takenLeft(document, 400)).toBe(200);
        side.hidden = true;
        expect(takenLeft(document, 400)).toBe(154);
        // Held in the dock's tab: inside a Maestro window, not at the left of the page.
        const slot = document.createElement('div');
        slot.className = 'maestro-m32d-slot';
        slot.append(des);
        document.body.append(slot);
        expect(takenLeft(document, 400)).toBe(0);
        // DES's panel on the right is not in the way.
        const right = boxed(document.createElement('div'), { left: 1446, top: 40, width: 154, height: 960 });
        right.id = 'dooms-portrait-bar-wrapper';
        right.className = 'dooms-pb-position-right';
        document.body.append(right);
        expect(takenLeft(document, 400)).toBe(0);
    });

    it('measures the room from the window, the chat column and the drawer', () => {
        vi.stubGlobal('innerWidth', 1600);
        vi.stubGlobal('innerHeight', 1000);
        page();
        expect(measureSideRoom(document)).toEqual({
            viewportWidth: 1600,
            viewportHeight: 1000,
            phone: false,
            chat: { left: 400, top: 40, bottom: 900 },
            drawer: false,
            taken: 0,
        });
        vi.unstubAllGlobals();
    });
});

describe('the left panel', () => {
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

    async function setup(
        placement: 'chat' | 'left' = 'left',
        options: Parameters<typeof createPlayEnv>[0] = {},
    ): Promise<ReturnType<typeof page>> {
        const parts = page();
        env = await createPlayEnv({ locale: 'ru', ...options });
        env.settings.hudPlacement = placement;
        hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
        hud.install();
        await settlePlay(env);
        return parts;
    }

    const node = () => document.getElementById(HUD_ID);
    const section = (name: string) =>
        node()?.querySelector<HTMLElement>(`.maestro-m25-hud-side-holder[data-holder="${name}"]`) ?? null;

    it('shows every character of the scene with every value the HUD may show, conditions and items', async () => {
        await setup();
        await env.api.addStatus('Алекс', { name: 'Отравлен', duration: { turns: 3 }, icon: '☠' }, 'vitals');
        await env.api.giveItem('Алекс', { name: 'меч' });
        await env.api.equipItem('Алекс', 'меч', 'hand');
        await env.api.giveItem('Алекс', { name: 'верёвка', qty: 2 });
        // Only mana is pinned for the line over the chat: the left panel still shows everything.
        env.settings.hudAttrs = ['vitals.mana'];
        env.app.settings.notify('modules.mechanics.hudAttrs');
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', width: SIDE_MAX_WIDTH, beside: false });
        const panel = node()!;
        expect(panel.classList.contains(SIDE_CLASS)).toBe(true);
        expect(panel.dataset.layout).toBe('side');
        expect(panel.getAttribute('role')).toBe('region');
        expect(panel.getAttribute('aria-label')).toBe('Механики');
        expect(panel.querySelector('.maestro-m25-hud-grip')).toBeNull();
        const alex = section('Алекс')!;
        expect(alex.querySelector('details')?.open).toBe(true);
        expect(alex.querySelector('details > summary')?.textContent).toBe('Алекс');
        const hp = alex.querySelector<HTMLElement>('.maestro-m25-v-bar')!;
        expect(hp.querySelector('.maestro-m25-v-name')?.textContent).toBe('Здоровье');
        expect(hp.querySelector('.maestro-m25-v-sign')?.textContent).toBe('❤');
        expect(hp.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('80');
        expect(alex.textContent).toContain('80/100');
        expect(alex.textContent).toContain('40/40');
        expect(alex.textContent).toContain('Монеты');
        expect(alex.querySelector('.maestro-m25-chip-status')?.textContent).toContain('3 хода');
        const items = [...alex.querySelectorAll('.maestro-m25-chip-item')].map((chip) => chip.textContent);
        expect(items).toEqual(expect.arrayContaining(['меч', 'верёвка ×2']));
        // Kai is in the scene without being chosen; book, hidden and secret values never show here either.
        expect(section('Kai')?.textContent).toContain('80/100');
        expect(panel.textContent).not.toContain('Доверие');
        expect(panel.textContent).not.toContain('Обида');
        // The user's character first, the chosen ones next.
        const order = [...panel.querySelectorAll<HTMLElement>('.maestro-m25-hud-side-holder')].map(
            (item) => item.dataset.holder,
        );
        expect(order).toEqual(['Алекс', 'Kai']);
        // The characters scroll on their own and can be reached by the keyboard.
        const body = panel.querySelector<HTMLElement>('.maestro-m25-hud-side-body')!;
        expect(body.getAttribute('tabindex')).toBe('0');
        expect(body.getAttribute('aria-label')).toBe('Персонажи сцены');
        // The inventory is in the sections: only «Бросок» and the window.
        expect(panel.querySelector('.maestro-m25-hud-items')).toBeNull();
        expect(panel.querySelector('.maestro-m25-hud-roll')).not.toBeNull();
    });

    it('sits in the free space left of the chat, hugging it, scrolled when tall', async () => {
        await setup();
        const style = node()!.style;
        expect(style.left).toBe(`${400 - SIDE_GAP - SIDE_MAX_WIDTH}px`);
        expect(style.width).toBe(`${SIDE_MAX_WIDTH}px`);
        expect(style.top).toBe(`${40 + SIDE_GAP}px`);
        expect(style.maxHeight).toBe(`${900 - SIDE_GAP - (40 + SIDE_GAP)}px`);
    });

    it('keeps a folded character folded and shows the fight', async () => {
        await setup('left', { defs: [vitalsDef({ combat: {} }), feelingsDef()] });
        expect(node()!.querySelector('.maestro-m25-hud-side-fight')).toBeNull();
        const details = section('Kai')!.querySelector('details')!;
        details.open = false;
        details.dispatchEvent(new Event('toggle'));
        await env.api.startCombat({ enemies: ['Разбойник'] });
        await settlePlay(env);
        expect(section('Kai')!.querySelector('details')!.open).toBe(false);
        expect(section('Алекс')!.querySelector('details')!.open).toBe(true);
        const fight = env.api.combat()!;
        const now = fight.order[fight.current]!.holder;
        expect(node()!.querySelector('.maestro-m25-hud-side-fight')?.textContent).toBe(
            `Бой · раунд ${fight.round} · ходит ${now}`,
        );
    });

    it('goes over the chat while ST’s left drawer is open and comes back when it closes', async () => {
        const { drawer } = await setup();
        expect(hud!.layoutNow().mode).toBe('side');
        drawer.className = 'drawer-content fillLeft openDrawer';
        await settlePlay(env);
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'drawer' });
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(false);
        expect(node()!.querySelector('.maestro-m25-hud-grip')).not.toBeNull();
        expect(node()!.style.maxHeight).toBe('');
        expect(env.settings.hudPlacement).toBe('left');
        drawer.className = 'drawer-content fillLeft closedDrawer';
        await settlePlay(env);
        expect(hud!.layoutNow().mode).toBe('side');
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(true);
    });

    it('comes back from over the chat when only the left panel has something to show', async () => {
        // The user's character holds nothing: the line over the chat is empty, the left panel shows Kai.
        const { drawer } = await setup('left', { defs: [vitalsDef({ holders: { kind: 'characters' } })] });
        expect(section('Kai')).not.toBeNull();
        drawer.className = 'drawer-content fillLeft openDrawer';
        await settlePlay(env);
        expect(hud!.element()).toBeNull();
        drawer.className = 'drawer-content fillLeft closedDrawer';
        await settlePlay(env);
        expect(hud!.element()?.classList.contains(SIDE_CLASS)).toBe(true);
        expect(section('Kai')).not.toBeNull();
    });

    it('follows the window: narrow, then wide again; a phone never', async () => {
        await setup();
        vi.stubGlobal('innerWidth', SIDE_MIN_VIEWPORT - 1);
        globalThis.dispatchEvent(new Event('resize'));
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'narrow' });
        expect(node()!.querySelector('.maestro-m25-hud-holder[data-holder="Алекс"]')).not.toBeNull();
        vi.stubGlobal('innerWidth', 1600);
        globalThis.dispatchEvent(new Event('resize'));
        expect(hud!.layoutNow().mode).toBe('side');
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1000px'), media: query }));
        globalThis.dispatchEvent(new Event('resize'));
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'phone' });
        expect(node()!.classList.contains('maestro-m25-hud-line')).toBe(true);
        expect(env.settings.hudPlacement).toBe('left');
    });

    it('stands beside DES’s left portrait panel, and goes over the chat when it leaves no room', async () => {
        await setup();
        const des = boxed(document.createElement('div'), { left: 0, top: 300, width: 154, height: 400 });
        des.id = 'dooms-portrait-bar-wrapper';
        des.className = 'dooms-pb-position-left';
        document.body.append(des);
        await settlePlay(env, 1600);
        expect(hud!.layoutNow()).toMatchObject({
            mode: 'side',
            beside: true,
            left: 154 + SIDE_GAP,
            width: 400 - 154 - SIDE_GAP * 2,
        });
        // Two columns of portraits: too little room left.
        boxed(des, { left: 0, top: 300, width: 272, height: 400 });
        await settlePlay(env, 1600);
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'room' });
    });

    it('keeps the line over the chat with «over the chat», respects «HUD off» and leaves nothing behind', async () => {
        await setup('chat');
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'setting' });
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(false);
        env.settings.hudPlacement = 'left';
        env.app.settings.notify('modules.mechanics.hudPlacement');
        await settlePlay(env);
        expect(hud!.layoutNow().mode).toBe('side');
        env.settings.hud = false;
        env.app.settings.notify('modules.mechanics.hud');
        await settlePlay(env);
        expect(hud!.element()).toBeNull();
        env.settings.hud = true;
        env.app.settings.notify('modules.mechanics.hud');
        await settlePlay(env);
        expect(hud!.element()?.classList.contains(SIDE_CLASS)).toBe(true);
        hud!.dispose();
        expect(node()).toBeNull();
        // Observers are gone: a drawer opening later draws nothing.
        document.getElementById('left-nav-panel')!.className = 'drawer-content fillLeft openDrawer';
        await settlePlay(env);
        expect(node()).toBeNull();
        hud = null;
    });
});
