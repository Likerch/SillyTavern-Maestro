// @vitest-environment happy-dom
// M25 HUD (plan-2 §6.А п.4): the user's character and the chosen characters with the pinned values in their view,
// condition signs and what is worn; quick «Бросок» and «Инвентарь»; off with the setting or without mechanics;
// dragged to the top or the bottom and remembered per device; one scrolling line on a phone that expands on a tap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HUD_ID,
    HUD_STORAGE_KEY,
    MechanicsHud,
    hudTop,
    loadHudPlace,
    placeFromDrop,
    saveHudPlace,
} from '../../../src/features/mechanics/hud';
import { createPlayEnv, settlePlay } from './helpers-play';
import type { PlayEnv } from './helpers-play';
import { faces } from './helpers-checks';

let env: PlayEnv;
let hud: MechanicsHud | null = null;

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
});

afterEach(() => {
    hud?.dispose();
    hud = null;
    env?.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

async function setup(options: Parameters<typeof createPlayEnv>[0] = {}): Promise<void> {
    env = await createPlayEnv({ locale: 'ru', ...options });
    hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
    hud.install();
    await settlePlay(env);
}

const node = () => document.getElementById(HUD_ID);
const holder = (name: string) => node()?.querySelector<HTMLElement>(`[data-holder="${name}"]`) ?? null;

function notify(): void {
    env.app.settings.notify('modules.mechanics.hud');
}

describe('what the HUD shows', () => {
    it('shows the user’s character with the values the HUD may show, conditions and what is worn', async () => {
        await setup();
        await env.api.addStatus('Алекс', { name: 'Отравлен', duration: { turns: 3 }, icon: '☠' }, 'vitals');
        await env.api.giveItem('Алекс', { name: 'меч' });
        await env.api.equipItem('Алекс', 'меч', 'hand');
        await settlePlay(env);
        expect(hud!.element()).toBe(node());
        const alex = holder('Алекс')!;
        expect(alex.querySelector('.maestro-m25-hud-name')?.textContent).toBe('Алекс');
        expect(alex.querySelector('[role="meter"][aria-label="Здоровье"]')?.getAttribute('aria-valuenow')).toBe('80');
        expect(alex.textContent).toContain('80/100');
        expect(alex.textContent).toContain('40/40');
        expect(alex.textContent).toContain('30');
        expect(alex.querySelector('.maestro-m25-chip-status')?.textContent).toContain('Отравлен');
        expect(alex.querySelector('.maestro-m25-chip-status')?.textContent).toContain('3');
        expect(alex.querySelector('.maestro-m25-chip-item')?.textContent).toContain('меч');
        // Kai is not chosen; book and hidden values never show numbers in the HUD.
        expect(holder('Kai')).toBeNull();
        expect(node()?.textContent).not.toContain('Доверие');
        expect(node()?.textContent).not.toContain('Отношение');
    });

    it('follows the pins and the chosen characters', async () => {
        await setup();
        env.settings.hudAttrs = ['vitals.mana'];
        env.settings.hudHolders = ['kai'];
        notify();
        await settlePlay(env);
        const alex = holder('Алекс')!;
        expect(alex.querySelectorAll('.maestro-m25-v')).toHaveLength(1);
        expect(alex.textContent).toContain('40/40');
        expect(alex.textContent).not.toContain('80/100');
        expect(holder('Kai')?.textContent).toContain('40/40');
    });

    it('is off with the setting, without a chat and without mechanics', async () => {
        await setup();
        expect(node()).not.toBeNull();
        env.settings.hud = false;
        notify();
        await settlePlay(env);
        expect(hud!.element()).toBeNull();
        env.settings.hud = true;
        notify();
        await settlePlay(env);
        expect(hud!.element()).not.toBeNull();
        env.defs.defs = [];
        env.defs.emit();
        await settlePlay(env);
        expect(hud!.element()).toBeNull();
    });

    it('rolls from «Бросок» with advantage and shows the inventory', async () => {
        await setup({ rng: faces(20, 15, 4) });
        await env.api.giveItem('Алекс', { name: 'верёвка', qty: 2 });
        await settlePlay(env);
        node()!.querySelector<HTMLButtonElement>('.maestro-m25-hud-roll')!.click();
        node()!.querySelector<HTMLButtonElement>('.maestro-m25-hud-mode-adv')!.click();
        node()!.querySelector<HTMLButtonElement>('.maestro-m25-hud-check')!.click();
        await settlePlay(env);
        expect(env.api.checks()[0]).toMatchObject({ holder: 'Алекс', mode: 'adv', total: 15 });
        expect(env.ui.notices.at(-1)?.text).toContain('Заклинание (Алекс): 15 против 10');
        node()!.querySelector<HTMLButtonElement>('.maestro-m25-hud-items')!.click();
        expect(node()?.querySelector('.maestro-m25-hud-inventory')?.textContent).toContain('верёвка ×2');
        const open = vi.spyOn(env.ui, 'openWindow');
        node()!.querySelector<HTMLButtonElement>('.maestro-m25-hud-more')!.click();
        expect(open).toHaveBeenCalledWith('mechanics', { tab: 'mechanics' });
    });
});

describe('where the HUD sits', () => {
    it('is dragged to the bottom and remembered per device', async () => {
        await setup();
        const grip = node()!.querySelector<HTMLButtonElement>('.maestro-m25-hud-grip')!;
        grip.dispatchEvent(new PointerEvent('pointerdown', { clientY: 10, pointerId: 1, bubbles: true }));
        document.dispatchEvent(new PointerEvent('pointermove', { clientY: 400, pointerId: 1 }));
        expect(node()?.classList.contains('maestro-m25-hud-dragging')).toBe(true);
        document.dispatchEvent(new PointerEvent('pointerup', { clientY: 700, pointerId: 1 }));
        expect(node()?.classList.contains('maestro-m25-hud-dragging')).toBe(false);
        expect(hud!.placeNow().edge).toBe('bottom');
        expect(JSON.parse(localStorage.getItem(HUD_STORAGE_KEY) ?? '{}')).toMatchObject({ edge: 'bottom' });
        hud!.dispose();
        hud = new MechanicsHud({ app: env.app, log: env.app.log, settings: () => env.settings }, env.api);
        hud.install();
        expect(hud.placeNow().edge).toBe('bottom');
    });

    it('is one scrolling line on a phone that expands on a tap', async () => {
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('1000px'), media: query }));
        await setup();
        expect(node()?.classList.contains('maestro-m25-hud-line')).toBe(true);
        node()!.querySelector<HTMLElement>('.maestro-m25-hud-rows')!.click();
        expect(node()?.classList.contains('maestro-m25-hud-line')).toBe(false);
    });

    it('keeps its place inside the chat area', () => {
        const area = { top: 50, bottom: 650, left: 0, right: 800 };
        expect(hudTop(area, { edge: 'top', offset: 20 }, 40)).toBe(70);
        expect(hudTop(area, { edge: 'bottom', offset: 10 }, 40)).toBe(600);
        expect(hudTop(area, { edge: 'top', offset: 9999 }, 40)).toBe(610);
        expect(placeFromDrop(area, 60, 40)).toEqual({ edge: 'top', offset: 10 });
        expect(placeFromDrop(area, 560, 40)).toEqual({ edge: 'bottom', offset: 50 });
        expect(loadHudPlace({ getItem: () => 'not json' })).toEqual({ edge: 'top', offset: 0 });
        expect(loadHudPlace(null)).toEqual({ edge: 'top', offset: 0 });
        const stored: Record<string, string> = {};
        saveHudPlace({ setItem: (key, value) => (stored[key] = value) }, { edge: 'bottom', offset: 12 });
        expect(loadHudPlace({ getItem: (key) => stored[key] ?? null })).toEqual({ edge: 'bottom', offset: 12 });
        saveHudPlace(
            {
                setItem: () => {
                    throw new Error('full');
                },
            },
            { edge: 'top', offset: 1 },
        );
    });

    it('leaves nothing behind', async () => {
        await setup();
        expect(node()).not.toBeNull();
        hud!.dispose();
        hud!.dispose();
        expect(node()).toBeNull();
        hud = null;
    });
});
