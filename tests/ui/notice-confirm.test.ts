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
    it('keeps non-urgent notices quiet: no toast, no badge', () => {
        ui.notice('Тихое сообщение');
        expect(env.toastr.info).not.toHaveBeenCalled();
        expect(topBadge()?.hidden).toBe(true);
    });

    it('shows urgent notices as a toast of the matching level with the same text', () => {
        ui.notice('Сосед сломался', { urgent: true, level: 'error' });
        expect(env.toastr.error).toHaveBeenCalledTimes(1);
        expect(env.toastr.error.mock.calls[0]?.[0]).toBe('Сосед сломался');
        expect(env.toastr.error.mock.calls[0]?.[1]).toBe('Maestro');
        ui.notice('Лимит', { urgent: true, level: 'warn' });
        expect(env.toastr.warning).toHaveBeenCalledTimes(1);
    });

    it('runs the action when the toast is clicked and mentions it in the text', () => {
        const run = vi.fn();
        ui.notice('Вкладка устарела', { urgent: true, action: { label: 'Обновить', run } });
        const [text, , options] = env.toastr.info.mock.calls[0] as [string, string, { onclick: () => void }];
        expect(text).toContain('Обновить');
        options.onclick();
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

    it('accepts an element body', async () => {
        const body = document.createElement('ul');
        body.className = 'custom-body';
        await ui.confirm('a', body);
        const content = env.callGenericPopup.mock.calls[0]?.[0] as HTMLElement;
        expect(content.querySelector('.custom-body')).toBe(body);
    });
});
