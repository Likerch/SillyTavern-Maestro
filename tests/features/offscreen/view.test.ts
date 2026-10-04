// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { offscreenTab } from '../../../src/features/offscreen';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { answer, createOffscreenEnv, event, place, seedMira, seedScene, trackerMessage, userMessage } from './helpers';
import type { OffscreenEnv } from './helpers';

let env: OffscreenEnv;
let container: HTMLElement;
let cleanup: Unsubscribe | void;

beforeEach(() => {
    vi.useFakeTimers();
    env = createOffscreenEnv();
    seedScene(env);
    seedMira(env);
    env.places.places.push(place({ id: 'tavern', name: 'Таверна' }));
    for (let i = 0; i < 6; i++) {
        env.mock.chat.push(trackerMessage(`Таверна ${i}`, { location: 'Таверна' }), userMessage(`Ход ${i}`));
    }
    env.mock.chat.push(trackerMessage('Черновик', { location: 'Таверна' }));
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
    const tab = offscreenTab(env.app, env.service(), env.settings);
    expect(tab).toMatchObject({ id: 'offscreen', titleKey: 'm16.tab', order: 57, icon: 'fa-masks-theater' });
    cleanup = tab.render(container);
}

const text = () => container.textContent ?? '';
const buttons = (label: string) =>
    [...container.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);
const checkbox = (label: string) =>
    [...container.querySelectorAll('label')]
        .find((node) => node.textContent?.includes(label))
        ?.querySelector('input') as HTMLInputElement | undefined;
const number = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;

describe('backstage tab', () => {
    it('without a chat shows only the settings', async () => {
        env.mock.chatId = undefined;
        await env.start();
        render();
        expect(text()).toContain('No chat is open.');
        expect(text()).toContain('Turns between runs in «Balanced»');
        expect(buttons('Run now')).toHaveLength(0);
    });

    it('in a group chat says so', async () => {
        env.host.group = true;
        await env.start();
        render();
        expect(text()).toContain('Backstage does not work in group chats.');
    });

    it('shows the next run, the picker and no events yet; «Run now» queues the ticked characters', async () => {
        await env.start();
        render();
        expect(container.querySelector('.maestro-m16-next')?.textContent).toBe('Next run in 15 turns.');
        expect(text()).toContain('Nothing has happened off-screen yet.');
        const mira = checkbox('Mira');
        expect(mira?.checked).toBe(true);
        expect(text()).toContain('Mira — not in any scene yet');
        buttons('Run now')[0]!.click();
        await env.tick(50);
        expect(env.tasks.queued.at(-1)?.payload).toMatchObject({ reason: 'manual', characters: ['Mira'] });
        expect(env.ui.notices.at(-1)?.text).toBe('Backstage started: the events appear here in a minute.');
        expect(text()).toContain('A run waits in the background queue.');
        expect(buttons('Run now')[0]!.disabled).toBe(true);
    });

    it('unticked: Maestro picks by itself; nobody: a warning', async () => {
        await env.start();
        render();
        const mira = checkbox('Mira')!;
        mira.checked = false;
        mira.dispatchEvent(new Event('change'));
        buttons('Run now')[0]!.click();
        await env.tick(50);
        expect(env.tasks.queued.at(-1)?.payload.characters).toEqual(['Mira']);
        env.tasks.queued.length = 0;
        env.world.list = env.world.list.filter((item) => item.name !== 'Mira');
        env.des.known = [];
        cleanup?.();
        container.textContent = '';
        render();
        expect(text()).toContain('All the important characters are here right now');
        buttons('Run now')[0]!.click();
        await env.tick(50);
        expect(env.ui.notices.at(-1)).toMatchObject({ options: { level: 'warn' } });
    });

    it('lists the events: character, story time, status, rumour, place, links to the canon and the Inbox', async () => {
        env.llm.script = [
            answer(event({ location: 'Таверна' })),
            answer(event({ text: 'Mira was arrested by the city watch.', rumour: '' })),
        ];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        await service.execute('interval', ['Mira']);
        render();
        const events = [...container.querySelectorAll('.maestro-m16-event')];
        expect(events).toHaveLength(2);
        expect(events[0]!.textContent).toContain('Mira was arrested by the city watch.');
        expect(events[0]!.textContent).toContain('in the Inbox');
        expect(events[0]!.textContent).toContain('drastic turn');
        expect(events[1]!.textContent).toContain('3 марта, 14:00');
        expect(events[1]!.textContent).toContain('in the canon');
        expect(events[1]!.textContent).toContain('Rumour: They say the herbalist got rich overnight.');
        expect(events[1]!.textContent).toContain('Now at: Таверна');
        expect(text()).toMatch(/Last run: .*, on schedule — Mira; events: 1, \$0\.0010\./);
        buttons('Inbox')[0]!.click();
        buttons('Canon')[0]!.click();
        expect(env.ui.opened).toEqual(['inbox', 'canon']);
    });

    it('a failed run and the modes are explained', async () => {
        env.llm.script = [{ ok: false, refusal: true, error: 'refusal' }];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        env.core.mode = 'economy';
        render();
        expect(text()).toMatch(/Last run: .*, by hand — failed: the model refused to answer\./);
        expect(container.querySelector('.maestro-m16-next')?.textContent).toBe(
            'In «Economy» backstage never runs by itself.',
        );
        env.core.mode = 'cinema';
        await env.turns(9);
        await env.tick(200);
        expect(container.querySelector('.maestro-m16-next')?.textContent).toBe(
            'Next run in 1 turn. Also at the end of every scene.',
        );
        env.settings().every.cinema = 0;
        await env.turns(1);
        await env.tick(200);
        expect(container.querySelector('.maestro-m16-next')?.textContent).toBe(
            'Automatic runs are off in this mode. Also at the end of every scene.',
        );
    });

    it('edits the settings', async () => {
        await env.start();
        render();
        const every = number('Turns between runs in «Cinema»')!;
        every.value = '7';
        every.dispatchEvent(new Event('change'));
        const max = number('Characters per run')!;
        max.value = '9';
        max.dispatchEvent(new Event('change'));
        const absent = number('Turns a character must be away')!;
        absent.value = '8';
        absent.dispatchEvent(new Event('change'));
        const balanced = number('Turns between runs in «Balanced»')!;
        balanced.value = '4';
        balanced.dispatchEvent(new Event('change'));
        const sceneEnd = checkbox('In «Balanced», also at the end of a scene')!;
        sceneEnd.checked = true;
        sceneEnd.dispatchEvent(new Event('change'));
        const rumours = checkbox('Rumours')!;
        rumours.checked = false;
        rumours.dispatchEvent(new Event('change'));
        expect(env.settings()).toMatchObject({
            every: { balanced: 4, cinema: 7 },
            sceneEnd: { balanced: true, cinema: true },
            maxCharacters: 3,
            minAbsentTurns: 8,
            rumours: false,
        });
    });
});
