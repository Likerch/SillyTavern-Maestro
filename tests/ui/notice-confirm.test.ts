// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { buildStDom, installUiEnv, POPUP_RESULT } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes } from '../helpers/ui-fakes';

let env: UiTestEnv;
let ui: UiImpl;

const topBadge = () => document.querySelector<HTMLElement>('#maestro-topbar .maestro-topbar-badge');

beforeEach(() => {
    buildStDom();
    env = installUiEnv('ru');
    env.settings.core().firstRunDone = true;
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
    ui.registerCoreViews(coreFakes(env));
});

afterEach(() => ui.dispose());

describe('notice()', () => {
    it('shows every notice as a short toast at «Всё» (the default) without a badge for non-urgent ones', () => {
        ui.notice('Тихое сообщение');
        expect(env.toastr.info).toHaveBeenCalledTimes(1);
        const [text, title, options] = env.toastr.info.mock.calls[0] as [string, string, { timeOut: number }];
        expect([text, title, options.timeOut]).toEqual(['Тихое сообщение', 'Maestro', 5000]);
        expect(topBadge()?.hidden).toBe(true);
    });

    it('filters toasts by the notification level; the Overview still lists everything', () => {
        env.settings.core().notifyLevel = 'important';
        ui.notice('Сведение');
        ui.notice('Важное', { importance: 'important' });
        ui.notice('Предупреждение', { level: 'warn' });
        ui.notice('Срочное', { urgent: true });
        expect(env.toastr.info.mock.calls.map((call) => call[0])).toEqual(['Важное', 'Срочное']);
        expect(env.toastr.warning.mock.calls.map((call) => call[0])).toEqual(['Предупреждение']);
        env.settings.core().notifyLevel = 'urgent';
        ui.notice('Ещё важное', { importance: 'important', level: 'warn' });
        ui.notice('Ещё срочное', { importance: 'urgent' });
        expect(env.toastr.warning).toHaveBeenCalledTimes(1);
        expect(env.toastr.info.mock.calls.map((call) => call[0])).toEqual(['Важное', 'Срочное', 'Ещё срочное']);
        ui.openPult('overview');
        expect(document.querySelectorAll('.maestro-notice')).toHaveLength(6);
    });

    it('merges notices of one group within a turn and starts again after the user sends a message', async () => {
        const undo = [vi.fn(), vi.fn(), vi.fn()];
        const groupText = (count: number) => `Запомнил ${count} факта`;
        ui.notice('Запомнил: праздник', { group: 'facts', groupText, action: { label: 'Отменить', run: undo[0]! } });
        ui.notice('Запомнил: таверна', { group: 'facts', groupText, action: { label: 'Отменить', run: undo[1]! } });
        ui.notice('Другое');
        ui.openPult('overview');
        const texts = () => [...document.querySelectorAll('.maestro-notice-text')].map((node) => node.textContent);
        expect(texts()).toEqual(['Другое', 'Запомнил 2 факта']);
        // The merged entry's button runs every action of the group (here: undo both facts).
        const merged = [...document.querySelectorAll<HTMLElement>('.maestro-notice')][1]!;
        merged.querySelector('button')!.click();
        expect(undo[0]).toHaveBeenCalledTimes(1);
        expect(undo[1]).toHaveBeenCalledTimes(1);
        // The previous toast of the group is replaced, not stacked.
        expect(env.toastr.clear).not.toHaveBeenCalled();
        await env.mock.eventSource.emit('message_sent', 3);
        ui.notice('Запомнил: мост', { group: 'facts', groupText, action: { label: 'Отменить', run: undo[2]! } });
        ui.openPult('overview');
        expect(texts()).toEqual(['Запомнил: мост', 'Другое', 'Запомнил 2 факта']);
    });

    it('merges without a group text as «first … и ещё N»', () => {
        ui.notice('Убрал событие о Флоренс', { group: 'offscreen' });
        ui.notice('Убрал событие о Марке', { group: 'offscreen' });
        ui.notice('Убрал событие об Иве', { group: 'offscreen' });
        ui.openPult('overview');
        expect(document.querySelector('.maestro-notice-text')?.textContent).toBe('Убрал событие о Флоренс и ещё 2');
        expect(env.toastr.info.mock.calls.at(-1)?.[0]).toBe('Убрал событие о Флоренс и ещё 2');
    });

    it('shows urgent notices as a toast of the matching level with the same text', () => {
        ui.notice('Сосед сломался', { urgent: true, level: 'error' });
        expect(env.toastr.error).toHaveBeenCalledTimes(1);
        expect(env.toastr.error.mock.calls[0]?.[0]).toBe('Сосед сломался');
        expect(env.toastr.error.mock.calls[0]?.[1]).toBe('Maestro');
        ui.notice('Лимит', { urgent: true, level: 'warn' });
        expect(env.toastr.warning).toHaveBeenCalledTimes(1);
    });

    it('puts the action on a button of the toast: the button acts, a click elsewhere opens the Overview', () => {
        const run = vi.fn();
        ui.notice('Вкладка устарела', { urgent: true, action: { label: 'Обновить', run } });
        const [message, , options] = env.toastr.info.mock.calls[0] as [
            HTMLElement,
            string,
            { onclick: (event?: { target: unknown }) => void; escapeHtml: boolean },
        ];
        // No «(по нажатию: …)» suffix any more: the text is the text, the action is a real button.
        expect(message.querySelector('.maestro-toast-text')?.textContent).toBe('Вкладка устарела');
        const button = message.querySelector<HTMLButtonElement>('.maestro-toast-action')!;
        expect(button.textContent).toBe('Обновить');
        expect(options.escapeHtml).toBe(false);
        options.onclick({ target: message.querySelector('.maestro-toast-text') });
        expect(run).not.toHaveBeenCalled();
        expect(document.querySelector('.maestro-pult')).not.toBeNull();
        options.onclick({ target: button });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('counts unseen urgent notices in the top-bar badge until the Overview shows them', () => {
        ui.notice('Срочно 1', { urgent: true });
        ui.notice('Срочно 2', { urgent: true, level: 'warn' });
        expect(topBadge()?.textContent).toBe('2');
        expect(topBadge()?.classList.contains('maestro-urgent')).toBe(true);
        ui.openPult('overview');
        expect(topBadge()?.hidden).toBe(true);
    });

    it('lists notices in the Overview tab with level styling and action buttons', () => {
        const run = vi.fn();
        ui.notice('Первое');
        ui.notice('Второе', { level: 'warn', action: { label: 'Сделать', run } });
        ui.openPult('overview');
        const items = [...document.querySelectorAll<HTMLElement>('.maestro-notice')];
        expect(items.map((item) => item.querySelector('.maestro-notice-text')?.textContent)).toEqual([
            'Второе',
            'Первое',
        ]);
        expect(items[0]?.classList.contains('maestro-level-warn')).toBe(true);
        items[0]?.querySelector('button')?.click();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('re-renders the open Overview when a notice arrives', () => {
        ui.openPult('overview');
        ui.notice('Новое');
        expect(document.querySelector('.maestro-notice-text')?.textContent).toBe('Новое');
    });
});

describe('confirm()', () => {
    it('asks through callGenericPopup CONFIRM and returns true on AFFIRMATIVE', async () => {
        env.callGenericPopup.mockResolvedValueOnce(POPUP_RESULT.AFFIRMATIVE);
        await expect(ui.confirm('Удалить?', 'Книга будет удалена')).resolves.toBe(true);
        const [content, type, , options] = env.callGenericPopup.mock.calls[0] ?? [];
        expect(type).toBe(2);
        expect((content as HTMLElement).querySelector('h3')?.textContent).toBe('Удалить?');
        expect((content as HTMLElement).textContent).toContain('Книга будет удалена');
        expect(options).toMatchObject({ okButton: 'Да', cancelButton: 'Нет' });
    });

    it('returns false on NEGATIVE, cancel and errors', async () => {
        env.callGenericPopup.mockResolvedValueOnce(POPUP_RESULT.NEGATIVE);
        await expect(ui.confirm('a', 'b')).resolves.toBe(false);
        env.callGenericPopup.mockResolvedValueOnce(null);
        await expect(ui.confirm('a', 'b')).resolves.toBe(false);
        env.callGenericPopup.mockRejectedValueOnce(new Error('no popup'));
        await expect(ui.confirm('a', 'b')).resolves.toBe(false);
    });

    it('keeps technical notes collapsed under «Подробнее»', async () => {
        await ui.confirm('Исправить книгу «Мир»?', 'Поменяю 2 записи.', { details: 'uid 4: role 2 → 0' });
        const content = env.callGenericPopup.mock.calls[0]?.[0] as HTMLElement;
        const details = content.querySelector<HTMLDetailsElement>('details.maestro-details')!;
        expect(details.open).toBe(false);
        expect(details.querySelector('summary')?.textContent).toBe('Подробнее');
        expect(details.textContent).toContain('uid 4: role 2 → 0');
    });

    it('accepts an element body', async () => {
        const body = document.createElement('ul');
        body.className = 'custom-body';
        await ui.confirm('a', body);
        const content = env.callGenericPopup.mock.calls[0]?.[0] as HTMLElement;
        expect(content.querySelector('.custom-body')).toBe(body);
    });
});
