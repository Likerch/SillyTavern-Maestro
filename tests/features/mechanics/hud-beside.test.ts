// @vitest-environment happy-dom
// M25 HUD beside the chat (hud-place.ts, hud-side.ts): a panel in the free space left or right of ST's chat column — in
// the compact view what the HUD over the chat shows, in the full view every character of the scene with every value
// the HUD may show, conditions, items and the fight — beside a Maestro window, DES's portrait panel or Top Info Bar's
// side bar; as wide as dragged (per device, side and view), folds remembered per device. Without the room (ST's drawer
// pinned on that side, a chat too wide) a rail at the chat's edge; ST's drawer merely open keeps the panel; phones keep
// the HUD over the chat. The saved setting never changes by itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUD_CSS, HUD_ID, MechanicsHud } from '../../../src/features/mechanics/hud';
import {
    RAIL_GAP,
    RAIL_WIDTH,
    SIDE_GAP,
    SIDE_VIEWS,
    drawerState,
    layoutKey,
    measureSideRoom,
    resolveHudLayout,
    takenLeft,
    takenRight,
} from '../../../src/features/mechanics/hud-place';
import type { SideRoom } from '../../../src/features/mechanics/hud-place';
import {
    HUD_SIDE_STORAGE_KEY,
    RAIL_CLASS,
    SIDE_CLASS,
    loadSidePrefs,
    saveSidePrefs,
} from '../../../src/features/mechanics/hud-side';
import { WIDGETS_CSS } from '../../../src/features/mechanics/widgets';
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

function page(): { sheld: HTMLElement; left: HTMLElement; right: HTMLElement } {
    // ST at 1600×1000: the top bar 40px, the chat column 50vw in the middle.
    const sheld = boxed(document.createElement('div'), { left: 400, top: 40, width: 800, height: 860 });
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

const wide: SideRoom = {
    viewportWidth: 1920,
    viewportHeight: 1080,
    phone: false,
    chat: { left: 480, right: 1440, top: 41, bottom: 1080 },
    drawers: { left: 'closed', right: 'closed' },
    taken: { left: 0, right: 1920 },
};

const compact = SIDE_VIEWS.compact;
const full = SIDE_VIEWS.full;

describe('where the mechanics go', () => {
    it('stays over the chat unless a side is chosen; a phone and a page without the chat keep it there', () => {
        expect(resolveHudLayout('chat', wide)).toEqual({ mode: 'chat', reason: 'setting' });
        expect(resolveHudLayout(undefined, wide)).toEqual({ mode: 'chat', reason: 'setting' });
        expect(resolveHudLayout('left', { ...wide, phone: true })).toEqual({ mode: 'chat', reason: 'phone' });
        expect(resolveHudLayout('right', { ...wide, phone: true })).toEqual({ mode: 'chat', reason: 'phone' });
        expect(resolveHudLayout('left', { ...wide, chat: null })).toEqual({ mode: 'chat', reason: 'room' });
    });

    it('goes left or right of the chat, hugging it, as wide as the view wants and the room allows', () => {
        const top = 41 + SIDE_GAP;
        expect(resolveHudLayout('left', wide)).toEqual({
            mode: 'side',
            side: 'left',
            left: 480 - SIDE_GAP - compact.width,
            top,
            width: compact.width,
            maxHeight: 1080 - SIDE_GAP - top,
            min: compact.min,
            max: 480 - SIDE_GAP * 2,
            beside: false,
        });
        expect(resolveHudLayout('right', wide, { view: 'full' })).toEqual({
            mode: 'side',
            side: 'right',
            left: 1440 + SIDE_GAP,
            top,
            width: full.width,
            maxHeight: 1080 - SIDE_GAP - top,
            min: full.min,
            max: 1920 - 1440 - SIDE_GAP * 2,
            beside: false,
        });
        // A dragged width is kept between the view's narrowest and the room.
        expect(resolveHudLayout('left', wide, { widths: { left: 300 } })).toMatchObject({ width: 300, left: 172 });
        expect(resolveHudLayout('left', wide, { widths: { left: 5000 } })).toMatchObject({ width: 464, left: 8 });
        expect(resolveHudLayout('left', wide, { widths: { left: 40 } })).toMatchObject({ width: compact.min });
        expect(resolveHudLayout('right', wide, { widths: { left: 400 } })).toMatchObject({ width: compact.width });
    });

    it('needs the view’s narrowest width: the compact view fits where the full one gets the rail', () => {
        const room: SideRoom = { ...wide, chat: { ...wide.chat!, left: 200 } };
        expect(resolveHudLayout('left', room)).toMatchObject({ mode: 'side', width: 200 - SIDE_GAP * 2 });
        expect(resolveHudLayout('left', room, { view: 'full' })).toMatchObject({ mode: 'rail', reason: 'room' });
        expect(compact.min).toBe(150);
        expect(full.min).toBe(220);
    });

    it('gives the rail when ST’s drawer is pinned on that side, and keeps the panel while it is only open', () => {
        const pinned = resolveHudLayout('left', { ...wide, drawers: { left: 'pinned', right: 'closed' } });
        expect(pinned).toEqual({
            mode: 'rail',
            side: 'left',
            reason: 'drawer',
            // The drawer covers the gap: the tab stands over the chat's edge.
            outside: false,
            left: 480,
            top: 41 + SIDE_GAP,
            flyout: {
                left: 480 + RAIL_WIDTH + RAIL_GAP,
                top: 41 + SIDE_GAP,
                width: compact.width,
                maxHeight: 1080 - SIDE_GAP - (41 + SIDE_GAP),
            },
            other: true,
        });
        expect(resolveHudLayout('left', { ...wide, drawers: { left: 'open', right: 'closed' } })).toMatchObject({
            mode: 'side',
            side: 'left',
        });
        expect(resolveHudLayout('right', { ...wide, drawers: { left: 'closed', right: 'pinned' } })).toMatchObject({
            mode: 'rail',
            side: 'right',
            reason: 'drawer',
            outside: false,
            left: 1440 - RAIL_WIDTH,
        });
        // The right side does not care about the left drawer.
        expect(resolveHudLayout('right', { ...wide, drawers: { left: 'pinned', right: 'closed' } }).mode).toBe('side');
    });

    it('puts the rail’s tab outside the chat when the gap holds it, else over the chat’s edge', () => {
        const narrow = (left: number, right: number): SideRoom => ({
            ...wide,
            chat: { left, right, top: 41, bottom: 1080 },
        });
        expect(resolveHudLayout('left', narrow(100, 1820))).toMatchObject({
            mode: 'rail',
            reason: 'room',
            outside: true,
            left: 100 - RAIL_GAP - RAIL_WIDTH,
            flyout: { left: 100, width: compact.width },
            other: false,
        });
        expect(resolveHudLayout('left', narrow(20, 1900))).toMatchObject({
            outside: false,
            left: 20,
            flyout: { left: 20 + RAIL_WIDTH + RAIL_GAP },
        });
        expect(resolveHudLayout('right', narrow(100, 1850))).toMatchObject({
            mode: 'rail',
            outside: true,
            left: 1850 + RAIL_GAP,
            flyout: { left: 1850 + RAIL_GAP - RAIL_GAP - compact.width, width: compact.width },
        });
        expect(resolveHudLayout('right', narrow(100, 1900))).toMatchObject({
            outside: false,
            left: 1900 - RAIL_WIDTH,
            flyout: { left: 1900 - RAIL_WIDTH - RAIL_GAP - compact.width },
        });
        // Too little room on the left, plenty on the right: the flyout offers the other side.
        expect(resolveHudLayout('left', narrow(100, 1440))).toMatchObject({ mode: 'rail', other: true });
    });

    it('stands beside the neighbours’ panels on either side', () => {
        expect(resolveHudLayout('left', { ...wide, taken: { left: 154, right: 1920 } })).toMatchObject({
            mode: 'side',
            width: compact.width,
            left: 480 - SIDE_GAP - compact.width,
            max: 480 - 154 - SIDE_GAP * 2,
            beside: true,
        });
        expect(resolveHudLayout('right', { ...wide, taken: { left: 0, right: 1700 } })).toMatchObject({
            mode: 'side',
            width: compact.width,
            max: 1700 - 1440 - SIDE_GAP * 2,
            beside: true,
        });
        // Two columns of DES portraits leave too little: the rail, outside the chat in the rest of the gap.
        expect(resolveHudLayout('left', { ...wide, taken: { left: 400, right: 1920 } })).toMatchObject({
            mode: 'rail',
            reason: 'room',
            outside: true,
            left: 480 - RAIL_GAP - RAIL_WIDTH,
        });
    });

    it('draws again only when the kind of place, its side or the rail’s reason changes', () => {
        const side = resolveHudLayout('left', wide);
        expect(layoutKey(side)).toBe('side:left');
        expect(layoutKey(resolveHudLayout('left', wide, { widths: { left: 300 } }))).toBe(layoutKey(side));
        expect(layoutKey(resolveHudLayout('left', { ...wide, drawers: { left: 'pinned', right: 'closed' } }))).toBe(
            'rail:left:drawer:true',
        );
        expect(layoutKey({ mode: 'chat', reason: 'phone' })).toBe('chat:phone');
        expect(layoutKey({ mode: 'chat', reason: 'setting' })).toBe('chat');
    });
});

describe('reading the page', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
    });

    it('knows ST’s drawers pinned, open or closed', () => {
        const { left, right } = page();
        expect(drawerState(document, 'left')).toBe('closed');
        left.className = 'drawer-content fillLeft openDrawer';
        expect(drawerState(document, 'left')).toBe('open');
        left.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        expect(drawerState(document, 'left')).toBe('pinned');
        // Pinned but closed by its icon: the gap is free.
        left.className = 'drawer-content fillLeft pinnedOpen closedDrawer';
        expect(drawerState(document, 'left')).toBe('closed');
        right.className = 'drawer-content fillRight pinnedOpen openDrawer';
        expect(drawerState(document, 'right')).toBe('pinned');
        right.remove();
        expect(drawerState(document, 'right')).toBe('closed');
    });

    it('finds the panels at the left: DES, Maestro’s side, Top Info Bar’s side bar only in the gap', () => {
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
        // Top Info Bar's side bar: in the gap it counts, reaching over the chat it does not.
        const bar = boxed(document.createElement('div'), { left: 0, top: 40, width: 250, height: 900 });
        bar.id = 'extensionSideBar';
        document.body.append(bar);
        expect(takenLeft(document, 400)).toBe(250);
        boxed(bar, { left: 0, top: 40, width: 600, height: 900 });
        expect(takenLeft(document, 400)).toBe(0);
        bar.style.display = 'none';
        boxed(bar, { left: 0, top: 0, width: 0, height: 0 });
        expect(takenLeft(document, 400)).toBe(0);
    });

    it('finds the panels at the right: DES in «right» mode and Maestro’s right side', () => {
        page();
        expect(takenRight(document, 1200, 1600)).toBe(1600);
        const des = boxed(document.createElement('div'), { left: 1446, top: 40, width: 154, height: 960 });
        des.id = 'dooms-portrait-bar-wrapper';
        des.className = 'dooms-pb-position-right';
        document.body.append(des);
        expect(takenRight(document, 1200, 1600)).toBe(1446);
        const side = boxed(document.createElement('div'), { left: 1300, top: 40, width: 300, height: 960 });
        side.className = 'maestro-window-side maestro-window-side-right';
        document.body.append(side);
        expect(takenRight(document, 1200, 1600)).toBe(1300);
        // DES's panel on the left is not in the way on the right.
        des.className = 'dooms-pb-position-left';
        side.hidden = true;
        expect(takenRight(document, 1200, 1600)).toBe(1600);
    });

    it('measures the room from the window, the chat column and the drawers', () => {
        vi.stubGlobal('innerWidth', 1600);
        vi.stubGlobal('innerHeight', 1000);
        const { right } = page();
        right.className = 'drawer-content fillRight openDrawer';
        expect(measureSideRoom(document)).toEqual({
            viewportWidth: 1600,
            viewportHeight: 1000,
            phone: false,
            chat: { left: 400, right: 1200, top: 40, bottom: 900 },
            drawers: { left: 'closed', right: 'open' },
            taken: { left: 0, right: 1600 },
        });
    });

    it('remembers widths and folds per device, and survives a broken record', () => {
        expect(loadSidePrefs(null)).toEqual({ widths: {}, folded: [] });
        expect(loadSidePrefs({ getItem: () => 'not json' })).toEqual({ widths: {}, folded: [] });
        expect(
            loadSidePrefs({
                getItem: () =>
                    JSON.stringify({
                        widths: { 'left.compact': 260.4, 'up.full': 300, 'right.full': -1 },
                        folded: ['Kai', 'kai', 3, ''],
                    }),
            }),
        ).toEqual({ widths: { 'left.compact': 260 }, folded: ['kai'] });
        const stored: Record<string, string> = {};
        saveSidePrefs(
            { setItem: (key, value) => (stored[key] = value) },
            { widths: { 'right.full': 300 }, folded: [] },
        );
        expect(JSON.parse(stored[HUD_SIDE_STORAGE_KEY]!)).toEqual({ widths: { 'right.full': 300 }, folded: [] });
        saveSidePrefs(
            {
                setItem: () => {
                    throw new Error('full');
                },
            },
            { widths: {}, folded: [] },
        );
    });
});

describe('the panel beside the chat', () => {
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
        document.documentElement.removeAttribute('style');
    });

    async function setup(
        placement: 'chat' | 'left' | 'right' = 'left',
        options: Parameters<typeof createPlayEnv>[0] & { view?: 'compact' | 'full' } = {},
    ): Promise<ReturnType<typeof page>> {
        const parts = page();
        env = await createPlayEnv({ locale: 'ru', ...options });
        env.settings.hudPlacement = placement;
        env.settings.hudSideView = options.view ?? 'compact';
        hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
        hud.install();
        await settlePlay(env);
        return parts;
    }

    const node = () => document.getElementById(HUD_ID);
    const section = (name: string) =>
        node()?.querySelector<HTMLElement>(`.maestro-m25-hud-side-holder[data-holder="${name}"]`) ?? null;
    const notify = (key: string) => env.app.settings.notify(`modules.mechanics.${key}`);

    it('full view: every character of the scene with every value the HUD may show, conditions and items', async () => {
        await setup('left', { view: 'full' });
        await env.api.addStatus('Алекс', { name: 'Отравлен', duration: { turns: 3 }, icon: '☠' }, 'vitals');
        await env.api.giveItem('Алекс', { name: 'меч' });
        await env.api.equipItem('Алекс', 'меч', 'hand');
        await env.api.giveItem('Алекс', { name: 'верёвка', qty: 2 });
        // Only mana is pinned for the line over the chat: the full view still shows everything.
        env.settings.hudAttrs = ['vitals.mana'];
        notify('hudAttrs');
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', side: 'left', width: full.width, beside: false });
        const panel = node()!;
        expect(panel.classList.contains(SIDE_CLASS)).toBe(true);
        expect(panel.dataset.layout).toBe('side');
        expect(panel.dataset.side).toBe('left');
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
        const order = [...panel.querySelectorAll<HTMLElement>('.maestro-m25-hud-side-holder')].map(
            (item) => item.dataset.holder,
        );
        expect(order).toEqual(['Алекс', 'Kai']);
        const body = panel.querySelector<HTMLElement>('.maestro-m25-hud-side-body')!;
        expect(body.getAttribute('tabindex')).toBe('0');
        expect(body.getAttribute('aria-label')).toBe('Персонажи сцены');
        // The inventory is in the sections: no «Инвентарь»; the view switch is on.
        expect(panel.querySelector('.maestro-m25-hud-items')).toBeNull();
        expect(panel.querySelector('.maestro-m25-hud-roll')).not.toBeNull();
        expect(panel.querySelector('.maestro-m25-hud-view')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('compact view: what the HUD over the chat shows, as a column — pins and chosen characters honoured', async () => {
        await setup();
        await env.api.addStatus('Алекс', { name: 'Отравлен', duration: { turns: 3 }, icon: '☠' }, 'vitals');
        await env.api.giveItem('Алекс', { name: 'меч' });
        await env.api.equipItem('Алекс', 'меч', 'hand');
        await env.api.giveItem('Алекс', { name: 'верёвка', qty: 2 });
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', width: compact.width });
        const panel = node()!;
        // Only the user's character: Kai is not chosen.
        expect(section('Kai')).toBeNull();
        let alex = section('Алекс')!;
        expect(alex.classList.contains('maestro-m25-hud-compact')).toBe(true);
        expect(alex.querySelector('details > summary')?.textContent).toBe('Алекс');
        const values = alex.querySelectorAll('.maestro-m25-hud-crow-values > .maestro-m25-v');
        expect(values).toHaveLength(3);
        expect(alex.textContent).toContain('80/100');
        expect(alex.querySelector('.maestro-m25-hud-crow-chips .maestro-m25-chip-status')?.textContent).toContain(
            '3 хода',
        );
        // What is worn shows; what is only carried is behind «Инвентарь».
        const chips = [...alex.querySelectorAll('.maestro-m25-chip-item')].map((chip) => chip.textContent);
        expect(chips).toEqual(['меч']);
        expect(panel.querySelector('.maestro-m25-hud-items')).not.toBeNull();
        expect(panel.querySelector('.maestro-m25-hud-view')?.getAttribute('aria-pressed')).toBe('false');
        expect(panel.querySelector('.maestro-m25-hud-side-fight')).toBeNull();
        panel.querySelector<HTMLButtonElement>('.maestro-m25-hud-items')!.click();
        expect(node()!.querySelector('.maestro-m25-hud-inventory')?.textContent).toContain('верёвка ×2');
        env.settings.hudAttrs = ['vitals.mana'];
        env.settings.hudHolders = ['kai'];
        notify('hudAttrs');
        await settlePlay(env);
        alex = section('Алекс')!;
        expect(alex.querySelectorAll('.maestro-m25-hud-crow-values > .maestro-m25-v')).toHaveLength(1);
        expect(alex.textContent).toContain('40/40');
        expect(alex.textContent).not.toContain('80/100');
        expect(section('Kai')?.textContent).toContain('40/40');
    });

    it('sits left of the chat hugging it, or right of it mirrored', async () => {
        await setup();
        let style = node()!.style;
        expect(style.left).toBe(`${400 - SIDE_GAP - compact.width}px`);
        expect(style.width).toBe(`${compact.width}px`);
        expect(style.top).toBe(`${40 + SIDE_GAP}px`);
        expect(style.maxHeight).toBe(`${900 - SIDE_GAP - (40 + SIDE_GAP)}px`);
        env.settings.hudPlacement = 'right';
        notify('hudPlacement');
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', side: 'right' });
        style = node()!.style;
        expect(node()!.dataset.side).toBe('right');
        expect(style.left).toBe(`${1200 + SIDE_GAP}px`);
        expect(style.width).toBe(`${compact.width}px`);
    });

    it('remembers folded characters per device, and shows the fight in the full view', async () => {
        await setup('left', { view: 'full', defs: [vitalsDef({ combat: {} }), feelingsDef()] });
        expect(node()!.querySelector('.maestro-m25-hud-side-fight')).toBeNull();
        const details = section('Kai')!.querySelector('details')!;
        details.open = false;
        details.dispatchEvent(new Event('toggle'));
        expect(JSON.parse(localStorage.getItem(HUD_SIDE_STORAGE_KEY) ?? '{}').folded).toEqual(['kai']);
        await env.api.startCombat({ enemies: ['Разбойник'] });
        await settlePlay(env);
        expect(section('Kai')!.querySelector('details')!.open).toBe(false);
        expect(section('Алекс')!.querySelector('details')!.open).toBe(true);
        const fight = env.api.combat()!;
        const now = fight.order[fight.current]!.holder;
        expect(node()!.querySelector('.maestro-m25-hud-side-fight')?.textContent).toBe(
            `Бой · раунд ${fight.round} · ходит ${now}`,
        );
        // Another page (a reload): still folded.
        hud!.dispose();
        hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
        hud.install();
        await settlePlay(env);
        expect(section('Kai')!.querySelector('details')!.open).toBe(false);
        section('Kai')!.querySelector('details')!.open = true;
        section('Kai')!.querySelector('details')!.dispatchEvent(new Event('toggle'));
        expect(JSON.parse(localStorage.getItem(HUD_SIDE_STORAGE_KEY) ?? '{}').folded).toEqual([]);
    });

    it('keeps the panel while ST’s drawer is only open; a pinned drawer gives the rail, unpinned the panel again', async () => {
        const { left } = await setup();
        left.className = 'drawer-content fillLeft openDrawer';
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', side: 'left' });
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(true);
        left.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ mode: 'rail', side: 'left', reason: 'drawer', other: true });
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(false);
        expect(node()!.classList.contains(RAIL_CLASS)).toBe(true);
        expect(env.settings.hudPlacement).toBe('left');
        left.className = 'drawer-content fillLeft pinnedOpen closedDrawer';
        await settlePlay(env);
        expect(hud!.layoutNow().mode).toBe('side');
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(true);
    });

    it('drags its outer edge to a width remembered per device, side and view, kept within the room', async () => {
        await setup();
        const edge = () => node()!.querySelector<HTMLElement>('.maestro-m25-hud-resize')!;
        expect(edge().getAttribute('role')).toBe('separator');
        expect(edge().getAttribute('aria-valuenow')).toBe(String(compact.width));
        edge().dispatchEvent(new PointerEvent('pointerdown', { clientX: 160, pointerId: 3, bubbles: true }));
        document.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, pointerId: 3 }));
        // The left panel grows to the left: its edge at the chat stays.
        expect(node()!.style.width).toBe(`${compact.width + 60}px`);
        expect(node()!.style.left).toBe(`${400 - SIDE_GAP - compact.width - 60}px`);
        document.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, pointerId: 3 }));
        expect(hud!.layoutNow()).toMatchObject({ mode: 'side', width: compact.width + 60 });
        expect(JSON.parse(localStorage.getItem(HUD_SIDE_STORAGE_KEY) ?? '{}').widths).toEqual({
            'left.compact': compact.width + 60,
        });
        // Never wider than the room.
        edge().dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, pointerId: 4, bubbles: true }));
        document.dispatchEvent(new PointerEvent('pointerup', { clientX: -900, pointerId: 4 }));
        expect(hud!.layoutNow()).toMatchObject({ width: 400 - SIDE_GAP * 2, left: SIDE_GAP });
        // The keyboard: the arrow towards the chat narrows it.
        edge().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(hud!.layoutNow()).toMatchObject({ width: 400 - SIDE_GAP * 2 - 16 });
        expect(edge().getAttribute('aria-valuenow')).toBe(String(400 - SIDE_GAP * 2 - 16));
        // The full view and the right side keep their own widths.
        env.settings.hudSideView = 'full';
        notify('hudSideView');
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ width: full.width });
        env.settings.hudPlacement = 'right';
        env.settings.hudSideView = 'compact';
        notify('hudPlacement');
        await settlePlay(env);
        expect(hud!.layoutNow()).toMatchObject({ side: 'right', width: compact.width });
        // A new page remembers.
        env.settings.hudPlacement = 'left';
        hud!.dispose();
        hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
        hud.install();
        await settlePlay(env);
        expect(hud.layoutNow()).toMatchObject({ side: 'left', width: 400 - SIDE_GAP * 2 - 16 });
    });

    it('follows the window and ST’s chat width: no room gives the rail, room the panel, a phone the line over the chat', async () => {
        const { sheld } = await setup();
        // ST's chat width slider: a style on <html>, the chat column wider at once (the poll is far away).
        boxed(sheld, { left: 100, top: 40, width: 1400, height: 860 });
        document.documentElement.style.setProperty('--sheldWidth', '88vw');
        await settlePlay(env, 100);
        expect(hud!.layoutNow()).toMatchObject({ mode: 'rail', side: 'left', reason: 'room', outside: true });
        boxed(sheld, { left: 400, top: 40, width: 800, height: 860 });
        globalThis.dispatchEvent(new Event('resize'));
        expect(hud!.layoutNow().mode).toBe('side');
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1000px'), media: query }));
        globalThis.dispatchEvent(new Event('resize'));
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'phone' });
        expect(node()!.classList.contains('maestro-m25-hud-line')).toBe(true);
        expect(node()!.querySelector('.maestro-m25-hud-place')).toBeNull();
        expect(env.settings.hudPlacement).toBe('left');
    });

    it('comes back from over the chat when only the full view has something to show', async () => {
        // The user's character holds nothing: the line over the chat (a phone) is empty, the full view shows Kai.
        await setup('left', { view: 'full', defs: [vitalsDef({ holders: { kind: 'characters' } })] });
        expect(section('Kai')).not.toBeNull();
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1000px'), media: query }));
        globalThis.dispatchEvent(new Event('resize'));
        expect(hud!.element()).toBeNull();
        vi.unstubAllGlobals();
        vi.stubGlobal('innerWidth', 1600);
        vi.stubGlobal('innerHeight', 1000);
        await settlePlay(env, 1600);
        expect(hud!.element()?.classList.contains(SIDE_CLASS)).toBe(true);
        expect(section('Kai')).not.toBeNull();
    });

    it('hides the DES strip only while the panel shows, on either side', async () => {
        expect(WIDGETS_CSS).toContain(
            `body:has(#${HUD_ID}.${SIDE_CLASS}[data-side="left"]:not([hidden])) .maestro-m25-strip`,
        );
        expect(WIDGETS_CSS).toContain(
            `body:has(#${HUD_ID}.${SIDE_CLASS}[data-side="right"]:not([hidden])) .maestro-m25-strip`,
        );
        expect(HUD_CSS).toContain('@media (prefers-reduced-motion: reduce)');
        const { left } = await setup('right');
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(true);
        expect(node()!.dataset.side).toBe('right');
        env.settings.hudPlacement = 'left';
        left.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        notify('hudPlacement');
        await settlePlay(env);
        // The rail leaves the strip be.
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(false);
        expect(node()!.dataset.layout).toBe('rail');
    });

    it('keeps the line over the chat with «over the chat», respects «HUD off» and leaves nothing behind', async () => {
        await setup('chat');
        expect(hud!.layoutNow()).toEqual({ mode: 'chat', reason: 'setting' });
        expect(node()!.classList.contains(SIDE_CLASS)).toBe(false);
        expect(node()!.dataset.side).toBeUndefined();
        env.settings.hudPlacement = 'left';
        notify('hudPlacement');
        await settlePlay(env);
        expect(hud!.layoutNow().mode).toBe('side');
        env.settings.hud = false;
        notify('hud');
        await settlePlay(env);
        expect(hud!.element()).toBeNull();
        env.settings.hud = true;
        notify('hud');
        await settlePlay(env);
        expect(hud!.element()?.classList.contains(SIDE_CLASS)).toBe(true);
        hud!.dispose();
        expect(node()).toBeNull();
        // Observers are gone: a drawer pinned later draws nothing.
        document.getElementById('left-nav-panel')!.className = 'drawer-content fillLeft pinnedOpen openDrawer';
        await settlePlay(env, 2000);
        expect(node()).toBeNull();
        hud = null;
    });
});
