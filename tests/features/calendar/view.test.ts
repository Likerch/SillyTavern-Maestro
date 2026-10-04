// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCalendarSettings } from '../../../src/features/calendar';
import type { CalendarSettings } from '../../../src/features/calendar';
import { calendarTab } from '../../../src/features/calendar/view';
import type { PultTab, Unsubscribe } from '../../../src/shared/contracts';
import { createCalendarEnv, fakeWorld } from './helpers';
import type { CalendarEnv } from './helpers';

let env: CalendarEnv;
let container: HTMLElement;
let cleanup: Unsubscribe | void;
let tab: PultTab;

const settings = () => readCalendarSettings((env.slices.calendar ??= {}) as Partial<CalendarSettings>);

beforeEach(() => {
    vi.useFakeTimers();
    env = createCalendarEnv();
    env.modules.expose('world', fakeWorld([{ name: 'Anna' }, { name: 'Boris' }]));
    env.mock.context.name1 = 'Алекс';
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
    tab = calendarTab(env.app, env.service(), settings);
    expect(tab).toMatchObject({ id: 'calendar', titleKey: 'm17.tab', order: 58, icon: 'fa-calendar-days' });
    cleanup = tab.render(container);
    await env.tick(150);
}

const text = () => container.textContent ?? '';
const buttons = (label: string) =>
    [...container.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);
const sectionOf = (title: string) =>
    [...container.querySelectorAll('section')].find((node) =>
        node.querySelector('.maestro-section-title')?.textContent?.startsWith(title),
    );

describe('calendar tab', () => {
    it('without a chat shows only the settings', async () => {
        env.mock.chatId = undefined;
        await env.start();
        await render();
        expect(text()).toContain('No chat is open.');
        expect(text()).toContain('Overdue after, story days');
        expect(sectionOf('Story time')).toBeUndefined();
        expect(sectionOf('Add a promise')).toBeUndefined();
    });

    it('shows the story time or says it is unknown', async () => {
        await env.start();
        await render();
        expect(text()).toContain('DES has not written a date or time yet.');
        await env.turn({ date: 'Monday, 12 Frostfall', start: '18:00', end: '19:15' });
        await env.tick(150);
        expect(text()).toContain('Story day 1');
        expect(text()).toContain('Date: Monday, 12 Frostfall');
        expect(text()).toContain('Time: 18:00–19:15');
        expect(text()).toContain('No open promises.');
    });

    it('lists promises by status with people, deadline, quote and source', async () => {
        const service = await env.start();
        const index = await env.turn({ date: 'Day 2', start: '10:00' });
        await service.intake({
            entityName: 'Anna',
            value: 'Anna promised to return the sword to Boris by sunset.',
            evidence: '«Верну к закату»',
            sourceMessage: index,
        });
        await service.add({
            who: ['Boris'],
            toWhom: [],
            what: 'Pay the toll',
            quote: '',
            due: { label: 'Day 1', day: 1 },
            sourceMessage: -1,
        });
        await service.add({
            who: [],
            toWhom: [],
            what: 'Feed the cat',
            quote: '',
            due: { label: 'Day 2', day: 2 },
            sourceMessage: -1,
        });
        const closed = await service.add({
            who: ['Anna'],
            toWhom: [],
            what: 'Sing a song',
            quote: '',
            due: null,
            sourceMessage: -1,
        });
        await service.setStatus(closed, 'done');
        await render();
        expect(sectionOf('The deadline has come (1)')?.textContent).toContain('Feed the cat');
        expect(sectionOf('Overdue (1)')?.textContent).toContain('Pay the toll');
        const open = sectionOf('Open (1)')?.textContent ?? '';
        expect(open).toContain('Anna → Boris');
        expect(open).toContain('Deadline: by sunset · story day 2, 19:00');
        expect(open).toContain('«Верну к закату»');
        expect(open).toContain('from the revision');
        expect(sectionOf('Closed (1)')?.textContent).toContain('Sing a song');
        expect(text()).toContain('someone');
        expect(tab.badge?.()).toBe(2);
        env.mock.context.executeSlashCommandsWithOptions = vi.fn(async () => ({}));
        buttons(`message #${index}`)[0]?.click();
        await env.tick(10);
        expect(env.mock.context.executeSlashCommandsWithOptions).toHaveBeenCalledWith(`/chat-jump ${index}`, {
            handleExecutionErrors: true,
        });
    });

    it('marks promises kept, cancelled, broken and reopens them', async () => {
        const service = await env.start();
        await env.turn({ date: 'Day 1', start: '10:00' });
        await service.add({
            who: ['Anna'],
            toWhom: [],
            what: 'Return the sword',
            quote: '',
            due: null,
            sourceMessage: -1,
        });
        await render();
        buttons('Kept')[0]?.click();
        await env.tick(150);
        expect(service.promises()[0]?.status).toBe('done');
        expect(sectionOf('Closed (1)')?.textContent).toContain('Return the sword');
        buttons('Reopen')[0]?.click();
        await env.tick(150);
        expect(service.promises()[0]?.status).toBe('open');
        buttons('Broken')[0]?.click();
        await env.tick(150);
        expect(service.promises()[0]?.status).toBe('broken');
        buttons('Reopen')[0]?.click();
        await env.tick(150);
        buttons('Cancelled')[0]?.click();
        await env.tick(150);
        expect(service.promises()[0]?.status).toBe('cancelled');
    });

    it('adds a promise from the form and keeps typed text across redraws', async () => {
        const service = await env.start();
        await env.turn({ date: 'Day 1', start: '10:00' });
        await render();
        const field = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
        field('What').value = 'Build a raft';
        await env.turn({ date: 'Day 1', start: '11:00' });
        await env.tick(150);
        expect(field('What').value).toBe('Build a raft');
        field('Who promised').value = 'Anna';
        field('To whom').value = 'Boris, Алекс';
        field('By when').value = 'in two days';
        field('Quote (optional)').value = 'Построю';
        buttons('Add')[0]?.click();
        await env.tick(150);
        expect(service.stored()).toMatchObject([
            {
                who: ['Anna'],
                toWhom: ['Boris', 'Алекс'],
                what: 'Build a raft',
                quote: 'Построю',
                due: { label: 'in two days', day: 3 },
                origin: 'user',
            },
        ]);
        expect(env.ui.notices.map((notice) => notice.text)).toContain('Promise added.');
        expect(field('What').value).toBe('');
        expect(text()).toContain('added by you');
        buttons('Add')[0]?.click();
        await env.tick(150);
        expect(env.ui.notices.at(-1)).toMatchObject({ text: 'Write what was promised.', options: { level: 'warn' } });
    });

    it('edits the overdue grace', async () => {
        await env.start();
        await render();
        const inputs = container.querySelectorAll<HTMLInputElement>('input[type="number"]');
        const [days, turns] = [...inputs];
        days!.value = '3';
        days!.dispatchEvent(new Event('change'));
        turns!.value = '500';
        turns!.dispatchEvent(new Event('change'));
        expect(settings()).toEqual({ overdueDays: 3, overdueTurns: 100 });
    });

    it('tells a follower tab who keeps the time', async () => {
        env.leader.value = false;
        await env.start();
        await render();
        expect(text()).toContain('Another Maestro tab follows the story time');
    });

    it('speaks Russian', async () => {
        await env.stop();
        env = createCalendarEnv('ru');
        const service = await env.start();
        await env.turn({ date: 'День 3', start: '10:00' });
        await service.add({
            who: ['Анна'],
            toWhom: ['Борис'],
            what: 'Вернуть меч',
            quote: '',
            due: { label: 'к закату', day: 3, minutes: 1140 },
            sourceMessage: -1,
        });
        await render();
        expect(text()).toContain('Время истории');
        expect(text()).toContain('День истории: 3');
        expect(text()).toContain('Срок: к закату · день истории 3, 19:00');
        expect(buttons('Выполнено')).toHaveLength(1);
        expect(buttons('Нарушено')).toHaveLength(1);
        expect(buttons('Отменено')).toHaveLength(1);
    });

    it('stops redrawing after it is closed', async () => {
        const service = await env.start();
        await render();
        if (typeof cleanup === 'function') cleanup();
        cleanup = undefined;
        const before = container.innerHTML;
        await service.add({ who: [], toWhom: [], what: 'Later', quote: '', due: null, sourceMessage: -1 });
        await env.tick(150);
        expect(container.innerHTML).toBe(before);
    });
});
