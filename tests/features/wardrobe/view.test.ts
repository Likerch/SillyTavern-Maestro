// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesFieldOffer, readWardrobeSettings, wardrobeTab } from '../../../src/features/wardrobe';
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

async function render(field?: DesFieldOffer): Promise<void> {
    tab = wardrobeTab(env.app, env.service(), settings, field);
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
        expect(text()).not.toContain('Characters with a look for pictures');
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
        expect(text()).toContain('Characters with a look for pictures');
        const card = cardOf('Anna')!;
        expect(card.textContent).toContain('Wearing: own clothes (from the card)');
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
        expect(card.textContent).toContain('Now: wet');
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
        expect(text()).toContain('Drawn as: Таверна');
        await env.turn({ location: 'Таверна', weather: 'Дождь' });
        await env.tick(150);
        expect(text()).toContain('States: rain');
        expect(text()).toContain('Now: rain');
        env.places.currentId = 'square';
        cleanup?.();
        container.textContent = '';
        await render();
        expect(text()).toContain('This place has no look for pictures');
    });

    it('says when NAI Studio is missing or another tab writes, and switches parts off', async () => {
        await env.start();
        env.naiPresent.value = false;
        await render();
        expect(text()).toContain('without NAI Studio 0.10 or newer');
        expect(text()).toContain('No character of this chat has a look for pictures');
        expect(text()).toContain('The current place is not known yet.');
        cleanup?.();
        container.textContent = '';
        env.naiPresent.value = true;
        env.leader.value = false;
        await render();
        expect(text()).toContain('Another Maestro tab follows the story');
        const toggles = [...container.querySelectorAll<HTMLInputElement>('.maestro-toggle input')];
        expect(toggles.map((node) => node.checked)).toEqual([true, true, true, true, true, true]);
        toggles[1]!.checked = false;
        toggles[1]!.dispatchEvent(new Event('change'));
        toggles[3]!.checked = false;
        toggles[3]!.dispatchEvent(new Event('change'));
        const numbers = [...container.querySelectorAll<HTMLInputElement>('input.maestro-number')];
        numbers[1]!.value = '4';
        numbers[1]!.dispatchEvent(new Event('change'));
        expect(settings()).toMatchObject({
            outfits: true,
            states: false,
            places: true,
            promptLine: false,
            personaEvery: 4,
        });
    });

    it('shows who is in the scene and what they wear, with «Put on another» and «This is a new outfit»', async () => {
        await env.start();
        await env.turn({
            characters: [
                { name: 'Anna', details: { appearance: 'Silver hair, in a dark blue silk dress' } },
                { name: 'Незнакомка', details: { appearance: 'в сером плаще' } },
            ],
        });
        await render();
        expect(text()).toContain('Who is in the scene and what they wear');
        const rows = () => [...container.querySelectorAll<HTMLElement>('.maestro-m27-now')];
        expect(rows()[0]!.textContent).toContain('in a dark blue silk dress');
        expect(rows()[0]!.textContent).toContain('New — remembered if it stays one more turn · since message #0');
        expect(rows()[0]!.textContent).toContain('from the appearance');
        expect(rows()[1]!.textContent).toContain('No look for pictures: only remembered');
        expect(rows()[1]!.querySelector('button')).toBeNull();
        const picker = rows()[0]!.querySelector('select')!;
        expect([...picker.options].map((option) => option.textContent)).toEqual(['Own clothes', 'ballgown']);
        picker.value = 'ballgown';
        picker.dispatchEvent(new Event('change'));
        buttons('Put on another')[0]!.click();
        await env.tick(150);
        expect(env.nai.getPassport('p-anna')!.activeOutfit).toBe('ballgown');
        expect(rows()[0]!.textContent).toContain('Outfit: «ballgown»');
        buttons('This is a new outfit')[0]!.click();
        await env.tick(150);
        expect(env.ui.notices.at(-1)?.text).toBe('Remembered as «blue silk dress».');
        expect(env.nai.getPassport('p-anna')!.activeOutfit).toBe('blue silk dress');
    });

    it('keeps what the user’s character wears, typed by hand', async () => {
        await env.start();
        await render();
        expect(text()).toContain('The tracker has not said what anyone wears yet.');
        const input = container.querySelector<HTMLTextAreaElement>('.maestro-m27-persona textarea')!;
        buttons('Remember')[0]!.click();
        await env.tick(150);
        expect(env.ui.notices.at(-1)?.text).toBe('Write what your character wears.');
        input.value = 'grey travel cloak and boots';
        buttons('Remember')[0]!.click();
        await env.tick(150);
        expect(env.ui.notices.at(-1)?.text).toBe('Remembered what you wear.');
        const persona = container.querySelector<HTMLElement>('.maestro-m27-persona .maestro-m27-now')!;
        expect(persona.textContent).toContain('Алекс');
        expect(persona.textContent).toContain('you');
        expect(persona.textContent).toContain('grey travel cloak and boots');
        expect(container.querySelector<HTMLTextAreaElement>('.maestro-m27-persona textarea')!.value).toBe(
            'grey travel cloak and boots',
        );
    });

    it('offers the clothing field of DES and lists revision cards it could not take', async () => {
        env.revision.card('Nobody wears a red hat.', 1, 'Nobody');
        await env.start();
        await env.tick(50);
        await render(new DesFieldOffer(env.app, env.app.log));
        expect(text()).toContain('Only the field «Outfit» is added to its tracker');
        expect(text()).toContain('Not taken from the revision');
        expect(text()).toContain('Nobody: «Nobody wears a red hat.» — nobody of this chat has that name.');
        buttons('Add the field')[0]!.click();
        await env.tick(150);
        expect(env.des.fields.at(-1)).toMatchObject({ id: 'outfit', name: 'Outfit' });
        cleanup?.();
        container.textContent = '';
        await render(new DesFieldOffer(env.app, env.app.log));
        expect(buttons('Add the field')).toEqual([]);
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
