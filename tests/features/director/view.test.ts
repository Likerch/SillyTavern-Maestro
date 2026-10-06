// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { directorTab, pluralKey } from '../../../src/features/director/view';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createDirectorEnv } from './helpers';
import type { DirectorEnv, TrackerParts } from './helpers';

let env: DirectorEnv;
let container: HTMLElement;
let cleanup: Unsubscribe | void;

const COMBAT =
    'Орк бросился в атаку, занося топор. Лиза уклонилась, клинок сверкнул, удар пришёлся врагу в плечо. Кровь брызнула на камни. Второй противник выхватил кинжал и напал сзади, бой закипел.';
const TAVERN: TrackerParts = {
    location: 'Таверна',
    characters: [{ name: 'Лиза' }],
    quests: { main: null, optional: ['Вернуть долг гильдии'] },
};

beforeEach(() => {
    vi.useFakeTimers();
    env = createDirectorEnv();
    env.des.known = ['Лиза'];
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

function render(): void {
    const tab = directorTab(env.app, env.service(), env.settings);
    expect(tab).toMatchObject({ id: 'director', titleKey: 'm13.tab', order: 55, icon: 'fa-clapperboard' });
    cleanup = tab.render(container);
}

const text = () => container.textContent ?? '';
const button = (label: string) =>
    [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);

describe('director tab', () => {
    it('without a chat shows only the settings', async () => {
        env.mock.chatId = undefined;
        env.start();
        await env.tick(50);
        render();
        expect(text()).toContain('No chat is open.');
        expect(text()).toContain('Stall after this many turns');
        expect(button('Shake it up')).toBeUndefined();
    });

    it('shows the scene, how long it holds, the flags and the stall', async () => {
        env.start();
        await env.tick(50);
        await env.reply(COMBAT, TAVERN);
        await env.send('…');
        render();
        expect(text()).toContain('Combat and danger');
        expect(text()).toMatch(/confidence \d+%/);
        expect(text()).toContain('holds 1 turn');
        expect(text()).toContain('by the rules');
        const flags = [...container.querySelectorAll('code.maestro-m13-flag')].map((node) => node.textContent);
        expect(flags).toEqual(['maestro_scene_combat', 'maestro_reply_short', 'maestro_lang_ru']);
        const title = container.querySelector('code.maestro-m13-flag')?.getAttribute('title');
        expect(title).toBe('Scene: combat and danger. A fight, a chase or immediate danger.');
        expect(text()).toContain('Turns without change: 1');
        expect(text()).toContain('No stall.');
        expect(text()).toContain('No notes yet.');

        await env.reply('— Что дальше? — спросила Лиза.\n— Посмотрим.', TAVERN);
        await env.send('Я выхватываю меч и бросаюсь на бандитов!');
        await env.tick(150);
        expect(container.querySelector('.maestro-m13-by')?.textContent).toBe('by your message');
    });

    it('the override select sets the scene type and back to automatic', async () => {
        env.start();
        await env.tick(50);
        await env.reply(COMBAT, TAVERN);
        await env.send('…');
        render();
        const select = container.querySelector('select') as HTMLSelectElement;
        expect(select.value).toBe('auto');
        expect([...select.options].map((option) => option.value)).toEqual([
            'auto',
            'dialogue',
            'combat',
            'intimate',
            'exploration',
            'timeskip',
            'social',
            'drama',
        ]);
        select.value = 'drama';
        select.dispatchEvent(new Event('change'));
        await env.tick(150);
        expect(env.service().override()).toBe('drama');
        expect(text()).toContain('chosen by you');
        expect(text()).toContain('maestro_scene_drama');
        const again = container.querySelector('select') as HTMLSelectElement;
        again.value = 'auto';
        again.dispatchEvent(new Event('change'));
        await env.tick(150);
        expect(env.service().override()).toBeNull();
    });

    it('«Встряхнуть» prepares a note and shows it; nothing to build from gives a warning', async () => {
        env.start();
        await env.tick(50);
        render();
        button('Shake it up')!.click();
        await env.tick(150);
        expect(env.ui.notices.at(-1)).toMatchObject({
            text: 'Nothing to build a twist from: the story has no open quests or loose threads.',
            options: { level: 'warn', urgent: true },
        });
        await env.reply('Тишина в зале.', TAVERN);
        await env.send('…');
        button('Shake it up')!.click();
        await env.tick(150);
        expect(env.ui.notices.at(-1)?.text).toContain("The director's note is ready");
        expect(text()).toContain('Note for the next turn');
        expect(text()).toContain('Вернуть долг гильдии');
        expect(text()).toContain('Quest');

        await env.reply('Тишина в зале.', TAVERN);
        await env.send('Давай уйдём.');
        await env.tick(150);
        expect(text()).toContain('The note was not added: you steered the plot yourself (plot words).');

        await env.service().nudge();
        await env.reply('Тишина в зале.', TAVERN);
        await env.send('Смотрю в окно.');
        await env.tick(150);
        expect(text()).toContain('Director’s notes');
        expect(container.querySelectorAll('.maestro-m13-written')).toHaveLength(1);
        expect(text()).toContain('on request');
        expect(text()).toMatch(/reply #\d+/);
    });

    it('shows the candidate, the model state and the «off in this mode» banner', async () => {
        env.core.mode = 'economy';
        env.llm.respond = () => ({ ok: true, data: { type: 'combat', confidence: 0.6 } });
        env.start();
        await env.tick(50);
        await env.reply('— Как дела? — спросила Лиза.\n— Хорошо.', TAVERN);
        await env.send('…');
        await env.reply('Он положил руку на меч и прислушался: где-то рядом враг.', TAVERN);
        await env.send('…');
        render();
        expect(text()).toContain('Waiting for confirmation: Combat and danger');
        expect(text()).toContain('ui.mode.economy');
        env.core.mode = 'balanced';
        await env.reply('Он выхватил меч и атаковал. Она поцеловала его, прижавшись губами к шее.', TAVERN);
        await env.send('…');
        await env.tick(150);
        expect(text()).toContain('asking the background model');
        await env.runTasks();
        await env.tick(150);
        expect(text()).toContain('The background model says: Combat and danger.');
    });

    it('edits the settings', async () => {
        env.start();
        await env.tick(50);
        render();
        const numbers = [...container.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
        expect(numbers.map((node) => node.value)).toEqual(['4', '0.6', '0', '6', '4']);
        numbers[0]!.value = '7';
        numbers[0]!.dispatchEvent(new Event('change'));
        numbers[1]!.value = '1.25';
        numbers[1]!.dispatchEvent(new Event('change'));
        numbers[3]!.value = '3';
        numbers[3]!.dispatchEvent(new Event('change'));
        expect(env.settings().stallTurns).toBe(7);
        expect(env.settings().userWeight).toBe(1.3);
        expect(env.settings().every.balanced).toBe(3);
        const toggles = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
        expect(toggles).toHaveLength(2);
        toggles[0]!.checked = false;
        toggles[0]!.dispatchEvent(new Event('change'));
        toggles[1]!.checked = false;
        toggles[1]!.dispatchEvent(new Event('change'));
        expect(env.settings()).toMatchObject({ model: false, pictures: false });
    });

    it('shows the picture cues with the flag', async () => {
        env.start();
        await env.tick(50);
        await env.reply('Лиза ждала у стойки.', TAVERN);
        await env.send('…');
        await env.reply('Лиза ждала у стойки.', { ...TAVERN, characters: [{ name: 'Лиза' }, { name: 'Орк' }] });
        await env.send('…');
        render();
        expect(text()).toContain('maestro_picture_moment');
        expect(text()).toContain('A picture fits: first appearance');
    });

    it('stops redrawing after unmount', async () => {
        env.start();
        await env.tick(50);
        render();
        if (typeof cleanup === 'function') cleanup();
        cleanup = undefined;
        await env.reply(COMBAT, TAVERN);
        await env.send('…');
        await env.tick(150);
        expect(container.querySelector('code.maestro-m13-flag')).toBeNull();
        expect(text()).toContain('No flags yet.');
    });
});

describe('plural forms', () => {
    it('picks Russian and English forms', () => {
        expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 112].map((n) => pluralKey(n, 'ru'))).toEqual([
            'one',
            'few',
            'few',
            'many',
            'many',
            'many',
            'many',
            'one',
            'few',
            'many',
            'one',
            'many',
        ]);
        expect([0, 1, 2].map((n) => pluralKey(n, 'en'))).toEqual(['many', 'one', 'many']);
    });
});
