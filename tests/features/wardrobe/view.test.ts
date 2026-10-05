// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWardrobeSettings, wardrobeTab } from '../../../src/features/wardrobe';
import type { WardrobeSettings } from '../../../src/features/wardrobe';
import type { PultTab, Unsubscribe } from '../../../src/shared/contracts';
import { createWardrobeEnv } from './helpers';
import type { WardrobeEnv } from './helpers';

let env: WardrobeEnv;
let container: HTMLElement;
let cleanup: Unsubscribe | void;
let tab: PultTab;

const settings = () => readWardrobeSettings((env.slices.wardrobe ??= {}) as Partial<WardrobeSettings>);

beforeEach(() => {
    vi.useFakeTimers();
    env = createWardrobeEnv();
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(async () => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    container.remove();
    await env.stop();
    vi.useRealTimers();
});

async function render(): Promise<void> {
    tab = wardrobeTab(env.app, env.service(), settings);
    expect(tab).toMatchObject({ id: 'wardrobe', titleKey: 'm27.tab', order: 60, icon: 'fa-shirt' });
    cleanup = tab.render(container);
    await env.tick(150);
}

const text = () => container.textContent ?? '';
const buttons = (label: string) =>
    [...container.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);
const cardOf = (title: string) =>
    [...container.querySelectorAll<HTMLElement>('.maestro-card')].find(
        (node) => node.querySelector('.maestro-card-title')?.textContent === title,
    );

describe('wardrobe tab', () => {
    it('without a chat or in a group chat shows only the settings', async () => {
        env.mock.chatId = undefined;
        await env.start();
        await render();
        expect(text()).toContain('No chat is open.');
        expect(text()).toContain('Character states');
        expect(text()).not.toContain('Characters with passports');
        cleanup?.();
        container.textContent = '';
        env.mock.chatId = 'chat-1';
        env.host.group = true;
        await render();
        expect(text()).toContain('Maestro sleeps in group chats.');
        expect(text()).not.toContain('In the scene');
    });

    it('lists the characters with their outfits and puts one on', async () => {
        await env.start();
        await render();
        expect(text()).toContain('Characters with passports');
        const card = cardOf('Anna')!;
        expect(card.textContent).toContain('Wearing: own clothes (clothing slot)');
        expect(card.textContent).toContain('ballgown');
        expect(card.textContent).toContain('white ball gown, long gloves, tiara');
        expect(card.textContent).toContain('No states on.');
        expect(cardOf('Boris')).toBeDefined();
        buttons('Put on')[0]!.click();
        await env.tick(150);
        expect(env.nai.of('setOutfit')).toEqual([['p-anna', 'ballgown', 'chat']]);
        const updated = cardOf('Anna')!;
        expect(updated.textContent).toContain('Wearing: ballgown');
        expect(updated.textContent).toContain('worn');
        expect(updated.textContent).toContain('Put on «ballgown»');
        expect(updated.textContent).toContain('by hand');
        buttons('Own clothes')[0]!.click();
        await env.tick(150);
        expect(env.nai.getPassport('p-anna')!.activeOutfit).toBe('');
    });

    it('shows the characters of the scene with states and undoes a change', async () => {
        await env.start();
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'Мокрая' } }] });
        await env.outfitSignal('Anna', 'Кожаная куртка', { messageIndex: 0 });
        await render();
        expect(text()).toContain('In the scene');
        expect(cardOf('Boris')).toBeUndefined();
        const card = cardOf('Anna')!;
        expect(card.textContent).toContain('States: wet');
        expect(card.textContent).toContain('Wearing: leather jacket');
        expect(card.textContent).toContain('Recognised from: Кожаная куртка');
        expect(card.textContent).toContain('New outfit «leather jacket»');
        expect(card.textContent).toContain('On: wet');
        expect(card.textContent).toContain('message #0');
        buttons('Undo')[0]!.click();
        await env.tick(150);
        expect(env.nai.getPassport('p-anna')!.outfits.map((outfit) => outfit.name)).toEqual(['ballgown']);
        expect(cardOf('Anna')!.textContent).toContain('undone');
    });

    it('says when undo is not possible', async () => {
        await env.start();
        await env.outfitSignal('Anna', 'Кожаная куртка', { messageIndex: 0 });
        await render();
        env.journal.records.length = 0;
        buttons('Undo')[0]!.click();
        await env.tick(150);
        expect(env.ui.notices.at(-1)?.text).toBe('Could not undo the change.');
    });

    it('shows the place with its passport and states, or that it has none', async () => {
        env.places.add('tavern', 'Таверна', { passportId: 'loc-tavern' });
        env.places.add('square', 'Площадь');
        env.places.currentId = 'tavern';
        await env.start();
        await render();
        expect(text()).toContain('Location passport: Таверна');
        await env.turn({ location: 'Таверна', weather: 'Дождь' });
        await env.tick(150);
        expect(text()).toContain('States: rain');
        expect(text()).toContain('On: rain');
        env.places.currentId = 'square';
        cleanup?.();
        container.textContent = '';
        await render();
        expect(text()).toContain('This place has no NAI location passport');
    });

    it('says when NAI Studio is missing or another tab writes, and switches parts off', async () => {
        await env.start();
        env.naiPresent.value = false;
        await render();
        expect(text()).toContain('NAI Studio 0.10 or newer is needed');
        expect(text()).toContain('No character of this chat has a NAI passport.');
        expect(text()).toContain('The current place is not known yet.');
        cleanup?.();
        container.textContent = '';
        env.naiPresent.value = true;
        env.leader.value = false;
        await render();
        expect(text()).toContain('Another Maestro tab follows the story');
        const toggles = [...container.querySelectorAll<HTMLInputElement>('.maestro-toggle input')];
        expect(toggles.map((node) => node.checked)).toEqual([true, true, true]);
        toggles[1]!.checked = false;
        toggles[1]!.dispatchEvent(new Event('change'));
        expect(settings()).toEqual({ outfits: true, states: false, places: true });
    });

    it('stops redrawing after cleanup', async () => {
        await env.start();
        await render();
        cleanup?.();
        cleanup = undefined;
        container.textContent = '';
        await env.service().wear('p-anna', 'ballgown');
        await env.tick(150);
        expect(text()).toBe('');
    });
});
