// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBackgroundsSettings } from '../../../src/features/backgrounds';
import type { BackgroundsSettings } from '../../../src/features/backgrounds';
import { backgroundsTab } from '../../../src/features/backgrounds/view';
import type { PultTab, Unsubscribe } from '../../../src/shared/contracts';
import { SETTLE, createBgEnv, url } from './helpers';
import type { BgEnv } from './helpers';

let env: BgEnv;
let container: HTMLElement;
let cleanup: Unsubscribe | void;
let tab: PultTab;

const settings = () => readBackgroundsSettings((env.slices.backgrounds ??= {}) as Partial<BackgroundsSettings>);

beforeEach(() => {
    vi.useFakeTimers();
    env = createBgEnv();
    env.library.push('tavern day.jpg', 'tavern night.jpg', 'royal.jpg', 'bedroom clean.jpg');
});

afterEach(async () => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    container?.remove();
    await env.stop();
    vi.useRealTimers();
});

async function render(): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    tab = backgroundsTab(env.app, env.service(), settings);
    expect(tab).toMatchObject({ id: 'backgrounds', titleKey: 'm29.tab', order: 62, icon: 'fa-image' });
    cleanup = tab.render(container);
    await env.tick(300);
}

const text = () => container.textContent ?? '';
const buttons = (label: string) =>
    [...container.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);
const sectionOf = (title: string) =>
    [...container.querySelectorAll('section')].find((node) =>
        node.querySelector('.maestro-section-title')?.textContent?.startsWith(title),
    );
const click = async (node: Element | undefined) => {
    expect(node).toBeDefined();
    (node as HTMLElement).click();
    await env.tick(SETTLE);
    await env.tick(300);
};

describe('backgrounds tab', () => {
    it('without a chat shows only the settings', async () => {
        env.mock.chatId = undefined;
        await env.start();
        await render();
        expect(text()).toContain('No chat is open.');
        expect(sectionOf('Settings')).toBeDefined();
        expect(sectionOf('Now')).toBeUndefined();
    });

    it('shows the place, the scene, who set the background and the candidates with thumbnails', async () => {
        const city = env.places.add('Порт-Ройал');
        const tavern = env.places.add('Таверна', { parent: city.id });
        await env.start();
        await env.turn({ time: '12:00', weather: 'Ясно' });
        await env.enter(tavern.id);
        await render();
        const now = sectionOf('Now')!;
        expect(now.textContent).toContain('Place: Порт-Ройал › Таверна');
        expect(now.textContent).toContain('Scene: day, clear');
        expect(now.textContent).toContain('Chat background set by Maestro: tavern day (picked from the library)');
        expect(now.querySelector('img')?.getAttribute('src')).toBe('/thumbnail?type=bg&file=tavern%20day.jpg');

        const list = sectionOf('For «Таверна»')!;
        const items = [...list.querySelectorAll('.maestro-m29-candidate')];
        // «royal» is a weak match through the parent «Порт-Ройал».
        expect(items.map((item) => item.querySelector('.maestro-m29-name')?.textContent)).toEqual([
            'tavern day',
            'royal',
            'tavern night',
        ]);
        expect(items[0]!.textContent).toContain('on now');
        expect(items[0]!.textContent).toContain('match 4');
        expect(items[0]!.querySelector('img')?.getAttribute('src')).toBe('/thumbnail?type=bg&file=tavern%20day.jpg');
        expect(buttons('Set')[0]?.hasAttribute('disabled')).toBe(true);

        const night = items[2]!;
        await click([...night.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Set'));
        expect(env.live()).toBe(url('tavern night.jpg'));
        expect(sectionOf('Now')!.textContent).toContain('tavern night (bound to the place)');
    });

    it('binds as the main background or a variant and unbinds', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.enter(tavern.id);
        await render();
        expect(sectionOf('Bound to the place')!.textContent).toContain('Nothing is bound');

        const night = [...container.querySelectorAll('.maestro-m29-candidate')].find(
            (item) => item.querySelector('.maestro-m29-name')?.textContent === 'tavern night',
        )!;
        await click(
            [...night.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Bind to the place'),
        );
        expect(env.places.get(tavern.id)?.background).toBe('tavern night.jpg');

        const bindAs = [...container.querySelectorAll('select')].find((node) =>
            [...node.options].some((option) => option.value === 'night'),
        )!;
        bindAs.value = 'night';
        bindAs.dispatchEvent(new Event('change'));
        await click(buttons('Bind to the place')[0]);
        expect(env.places.get(tavern.id)?.state).toEqual({ 'bg:night': 'tavern night.jpg' });

        const bound = sectionOf('Bound to the place')!;
        expect(bound.textContent).toContain('Main background');
        expect(bound.textContent).toContain('Variant: night');
        await click([...bound.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Unbind'));
        expect(env.places.get(tavern.id)?.background).toBeUndefined();
        await click(buttons('Unbind')[0]);
        expect(env.places.get(tavern.id)?.state).toEqual({});
    });

    it('marks a bound file that is missing from the library', async () => {
        const tavern = env.places.add('Таверна', { background: 'gone.jpg' });
        await env.start();
        await env.enter(tavern.id);
        await render();
        expect(sectionOf('Bound to the place')!.textContent).toContain('not in the library');
    });

    it("shows the user's own background and gives the choice back to Maestro", async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.userSets(url('bedroom clean.jpg'));
        await env.enter(tavern.id);
        await render();
        expect(text()).toContain('The chat background is yours: bedroom clean');
        await click(buttons('Let Maestro choose again')[0]);
        expect(env.live()).toBe(url('tavern day.jpg'));
        expect(buttons('Let Maestro choose again')).toHaveLength(0);

        await env.userSets('');
        await env.tick(300);
        expect(text()).toContain('You removed the background Maestro had set');
    });

    it('offers generation with an Anlas note, not in «Economy»', async () => {
        const cave = env.places.add('Пещера');
        await env.start();
        await env.enter(cave.id);
        await render();
        const generate = sectionOf('Generate a background')!;
        expect(generate.textContent).toContain('The library has no fitting background');
        expect(generate.textContent).toContain('«free only» mode');
        await click(buttons('Generate a background')[0]);
        expect(env.nai.calls).toHaveLength(1);
        expect(env.places.get(cave.id)?.background).toMatch(/^maestro-/);

        env.nai.hasApi = false;
        env.notifySettings('core.mode');
        await env.tick(300);
        expect(sectionOf('Generate a background')!.textContent).toContain('Needs NAI Studio 0.12');
        expect(buttons('Generate a background')[0]?.hasAttribute('disabled')).toBe(true);

        env.core.mode = 'economy';
        env.notifySettings('core.mode');
        await env.tick(300);
        expect(sectionOf('Generate a background')!.textContent).toContain('library only');
        expect(buttons('Generate a background')).toHaveLength(0);
    });

    it('switches the place and edits the settings', async () => {
        const tavern = env.places.add('Таверна');
        const bedroom = env.places.add('Спальня');
        env.leader.value = false;
        await env.start();
        env.places.currentId = tavern.id;
        await render();
        expect(text()).toContain('Another Maestro tab');
        const placeSelect = [...container.querySelectorAll('select')].find((node) =>
            [...node.options].some((option) => option.value === bedroom.id),
        )!;
        placeSelect.value = bedroom.id;
        placeSelect.dispatchEvent(new Event('change'));
        await env.tick(300);
        expect(sectionOf('For «Спальня»')!.textContent).toContain('bedroom clean');

        const toggles = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        toggles[0]!.checked = false;
        toggles[0]!.dispatchEvent(new Event('change'));
        toggles[1]!.checked = false;
        toggles[1]!.dispatchEvent(new Event('change'));
        const threshold = container.querySelector<HTMLInputElement>('input[type="number"]')!;
        threshold.value = '4.5';
        threshold.dispatchEvent(new Event('change'));
        expect(settings()).toEqual({ auto: false, variants: false, threshold: 4.5 });

        await click(buttons('Refresh the list')[0]);
        expect(text()).toContain('Backgrounds in the ST library: 4.');
    });

    it('warns when the place registry is off', async () => {
        env.modules.apis.delete('places');
        await env.start();
        await render();
        expect(text()).toContain('The «Places» module is off');
        expect(text()).toContain('The place is not known yet');
    });

    it('shows nothing broken when the action fails', async () => {
        const tavern = env.places.add('Таверна');
        await env.start();
        await env.enter(tavern.id);
        await render();
        env.places.update = async () => {
            throw new Error('places are busy');
        };
        await click(buttons('Bind to the place')[0]);
        expect(env.ui.notices.at(-1)?.text).toBe('places are busy');
    });
});

describe('settings slice', () => {
    it('repairs junk in place', () => {
        const slice: Partial<BackgroundsSettings> = { auto: 'yes' as never, threshold: 99 };
        expect(readBackgroundsSettings(slice)).toEqual({ auto: true, variants: true, threshold: 10 });
        expect(readBackgroundsSettings({ threshold: Number.NaN })).toMatchObject({ threshold: 3 });
        expect(readBackgroundsSettings({ threshold: 0 })).toMatchObject({ threshold: 1 });
    });
});

describe('strings', () => {
    it('has the same keys in English and Russian', async () => {
        const { BACKGROUNDS_STRINGS } = await import('../../../src/features/backgrounds/strings');
        expect(Object.keys(BACKGROUNDS_STRINGS.ru).sort()).toEqual(Object.keys(BACKGROUNDS_STRINGS.en).sort());
        expect(BACKGROUNDS_STRINGS.ru['kind.backgrounds.set']).toBeTruthy();
    });
});
