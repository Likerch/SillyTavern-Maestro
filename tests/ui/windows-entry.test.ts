// @vitest-environment happy-dom
// Ways into the windows (plan-2 §10 п.3): the Maestro menu (windows with badges, studios, running jobs, settings),
// the Maestro button of every chat message, and the core slash commands /maestro, /maestro-undo, /maestro-mode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserJobs } from '../../src/core/jobs';
import type { UserJobsService } from '../../src/core/jobs';
import type { JournalRecord, PultTab } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { normalizeName } from '../../src/ui/views/core-commands';
import { MESSAGE_BUTTON_CLASS } from '../../src/ui/views/message-button';
import { resetRegistries } from '../../src/ui/views/registries';
import { resetSlashSlots } from '../../src/ui/views/slash-commands';
import { buildStDom, installUiEnv, openWindows, rerenderMessage, windowBody } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes } from '../helpers/ui-fakes';
import type { CoreFakes } from '../helpers/ui-fakes';

let env: UiTestEnv;
let ui: UiImpl;
let jobs: UserJobsService;
let fakes: CoreFakes;

function tab(id: string, order: number, extra: Partial<PultTab> = {}): PultTab {
    return {
        id,
        titleKey: `test.${id}`,
        icon: 'fa-star',
        order,
        render(container: HTMLElement) {
            container.textContent = `content ${id}`;
        },
        ...extra,
    };
}

const toggle = () => document.querySelector<HTMLElement>('#maestro-topbar .maestro-topbar-toggle')!;
const menuItem = (id: string) => document.querySelector<HTMLElement>(`.maestro-menu-item[data-item="${id}"]`);
const menuIds = () =>
    [...document.querySelectorAll<HTMLElement>('.maestro-menu .maestro-menu-item')].map((node) => node.dataset.item);
const headings = () => [...document.querySelectorAll('.maestro-menu-heading')].map((node) => node.textContent);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function record(id: string, summary: string, extra: Partial<JournalRecord> = {}): JournalRecord {
    return {
        id,
        at: Date.now(),
        chatId: 'chat',
        module: 'canon',
        kind: 'canon.fact',
        summary,
        changes: [],
        ...extra,
    } as JournalRecord;
}

beforeEach(() => {
    resetRegistries();
    resetSlashSlots();
    buildStDom(3);
    document.body.insertAdjacentHTML(
        'beforeend',
        `<div id="message_template" class="template_element"><div class="mes"><div class="mes_buttons"><div class="extraMesButtons"><div class="mes_button mes_copy"></div></div></div></div></div>`,
    );
    for (const message of document.querySelectorAll('#chat .mes .mes_buttons')) {
        message.insertAdjacentHTML(
            'afterbegin',
            '<div class="extraMesButtons"><div class="mes_button mes_copy"></div></div>',
        );
    }
    env = installUiEnv('ru');
    env.settings.core().firstRunDone = true;
    env.i18n.register({
        en: {},
        ru: {
            'test.world': 'Мир-раздел',
            'test.calendar': 'Календарь',
            'test.mechanics': 'Механики',
            'test.dossier': 'Досье',
            'test.inbox': 'Входящие',
            'test.settings': 'Настройки',
            'test.overview': 'Обзор',
            'test.tasks': 'Задачи',
            'test.loreStudio': 'Лор-студия',
        },
    });
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
    jobs = createUserJobs({ log: env.log });
    fakes = coreFakes(env, { jobs });
    ui.registerCoreViews(fakes);
});

afterEach(() => {
    ui.dispose();
    jobs.dispose();
});

describe('the Maestro menu', () => {
    it('lists the windows with sections and badges, marks open ones, offers the studios and the settings', () => {
        ui.addTab(tab('calendar', 1, { badge: () => 3 }));
        ui.addWindow({
            id: 'loreStudio',
            titleKey: 'test.loreStudio',
            icon: 'fa-book-atlas',
            order: 200,
            hidden: true,
            render: (container) => void container.append('studio'),
        });
        ui.openPult('calendar');
        toggle().click();
        expect(headings()).toEqual(['Окна', 'Студии']);
        // Windows without sections (no module registered them) are not offered.
        expect(menuIds()).toEqual([
            'window:inbox',
            'window:world',
            'window:health',
            'window:maestro',
            'window:loreStudio',
            'settings',
        ]);
        expect(menuItem('window:world')?.querySelector('.maestro-menu-badge')?.textContent).toBe('3');
        expect(menuItem('window:world')?.classList.contains('maestro-on')).toBe(true);
        expect(menuItem('window:maestro')?.classList.contains('maestro-on')).toBe(false);
        menuItem('window:loreStudio')?.click();
        expect(ui.isWindowOpen('loreStudio')).toBe(true);
        toggle().click();
        menuItem('settings')?.click();
        expect(windowBody('maestro')?.dataset.tab).toBe('settings');
    });

    it('shows running jobs with progress; a click opens the job or the Tasks section', async () => {
        const open = vi.fn();
        const job = jobs.start({
            key: 'localize:World',
            title: 'Ключи для «World»',
            open: { label: 'Открыть', run: open },
        })!;
        job.progress(3, 10, 'Локализую: 3 из 10');
        jobs.start({ key: 'other', title: 'Другая задача' });
        toggle().click();
        expect(headings()).toContain('Твои задачи');
        const item = menuItem('job:localize:World')!;
        expect(item.querySelector('.maestro-menu-hint')?.textContent).toBe('Локализую: 3 из 10');
        expect(item.querySelector('.maestro-progress')?.getAttribute('aria-valuenow')).toBe('3');
        // The open menu follows the job.
        job.progress(7, 10, 'Локализую: 7 из 10');
        expect(menuItem('job:localize:World')?.querySelector('.maestro-menu-hint')?.textContent).toBe(
            'Локализую: 7 из 10',
        );
        menuItem('job:localize:World')?.click();
        expect(open).toHaveBeenCalledTimes(1);
        toggle().click();
        menuItem('job:other')?.click();
        expect(windowBody('health')?.dataset.tab).toBe('tasks');
        await flush();
    });

    it('closes on Escape, on a click elsewhere and moves between items with the arrows', () => {
        toggle().click();
        const menu = () => document.querySelector<HTMLElement>('.maestro-menu');
        expect(document.activeElement).toBe(menuItem('window:inbox'));
        menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        expect(document.activeElement).toBe(menuItem('window:health'));
        menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        expect(document.activeElement).toBe(menuItem('settings'));
        menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(menu()).toBeNull();
        toggle().click();
        document.querySelector('#chat')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        expect(menu()).toBeNull();
    });
});

describe('the Maestro button of a message', () => {
    const button = (index: number) =>
        document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"] .extraMesButtons .${MESSAGE_BUTTON_CLASS}`);

    function chat(): void {
        env.mock.chat = [
            { name: 'Me', is_user: true, is_system: false, send_date: '', mes: 'hi' },
            { name: 'Офелия', is_user: false, is_system: false, send_date: '', mes: 'hello' },
            { name: 'Narrator', is_user: false, is_system: true, send_date: '', mes: '...' },
        ] as never;
    }

    it('goes into every message and into ST’s message template, once', () => {
        expect(document.querySelector(`#message_template .extraMesButtons .${MESSAGE_BUTTON_CLASS}`)).not.toBeNull();
        for (const index of [0, 1, 2]) expect(button(index)).not.toBeNull();
        expect(document.querySelectorAll(`#chat .${MESSAGE_BUTTON_CLASS}`)).toHaveLength(3);
        expect(button(1)?.title).toBe('Maestro: досье, механики');
        ui.mount();
        expect(document.querySelectorAll(`#chat .${MESSAGE_BUTTON_CLASS}`)).toHaveLength(3);
    });

    it('comes back after ST re-renders a message', async () => {
        rerenderMessage(1);
        document.querySelector('#chat .mes[mesid="1"] .mes_buttons')!.innerHTML = '<div class="extraMesButtons"></div>';
        expect(button(1)).toBeNull();
        await env.host.events.emit('MESSAGE_UPDATED', 1);
        expect(button(1)).not.toBeNull();
    });

    it("a character's message offers the speaker's dossier and the mechanics", async () => {
        chat();
        const openByName = vi.fn(() => true);
        vi.spyOn(fakes.modules, 'api').mockImplementation(((key: string) =>
            key === 'dossier' ? { open: vi.fn(), openByName } : undefined) as never);
        ui.addTab(tab('mechanics', 1));
        button(1)!.click();
        expect(menuIds()).toEqual(['dossier', 'mechanics']);
        expect(menuItem('dossier')?.textContent).toContain('Досье: Офелия');
        menuItem('dossier')!.click();
        expect(openByName).toHaveBeenCalledWith('Офелия');
        button(1)!.click();
        menuItem('mechanics')!.click();
        expect(openWindows()).toContain('mechanics');
        // The user's own message and a system line: no dossier.
        button(0)!.click();
        expect(menuIds()).toEqual(['mechanics']);
        button(2)!.click();
        expect(menuIds()).toEqual(['mechanics']);
    });

    it('a speaker without a dossier opens the list with a word about it; nothing to offer → the Maestro window', () => {
        chat();
        vi.spyOn(fakes.modules, 'api').mockImplementation(((key: string) =>
            key === 'dossier' ? { open: vi.fn(), openByName: () => false } : undefined) as never);
        ui.addTab(tab('dossier', 1));
        button(1)!.click();
        menuItem('dossier')!.click();
        expect(windowBody('characters')?.dataset.tab).toBe('dossier');
        expect(env.toastr.info.mock.calls.at(-1)?.[0]).toBe('Досье на Офелия пока нет — открыл список.');
        vi.spyOn(fakes.modules, 'api').mockReturnValue(undefined);
        button(0)!.click();
        expect(menuIds()).toEqual(['maestro']);
    });

    it('leaves nothing behind on dispose', () => {
        ui.dispose();
        expect(document.querySelector(`.${MESSAGE_BUTTON_CLASS}`)).toBeNull();
        document.querySelector<HTMLElement>('#chat .mes[mesid="1"] .extraMesButtons')?.click();
        expect(document.querySelector('.maestro-menu')).toBeNull();
    });
});

describe('slash commands', () => {
    const run = (name: string, value = '') => env.slashCommands[name]!.callback({}, value);

    it('registers /maestro, /maestro-undo and /maestro-mode with help in the UI language', () => {
        for (const name of ['maestro', 'maestro-undo', 'maestro-mode']) expect(env.slashCommands[name]).toBeDefined();
        expect(env.slashCommands.maestro?.helpString).toContain('Открывает окно Maestro');
    });

    it('/maestro opens a window or a section by name in either language, the menu without one', async () => {
        ui.addTab(tab('calendar', 2));
        ui.addTab(tab('world', 1));
        await run('maestro', 'мир');
        expect(openWindows()).toEqual(['world']);
        await run('maestro', ' «Календарь» ');
        expect(windowBody('world')?.dataset.tab).toBe('calendar');
        await run('maestro', 'Health');
        expect(openWindows()).toContain('health');
        await run('maestro', 'journal');
        expect(windowBody('maestro')?.dataset.tab).toBe('journal');
        await run('maestro');
        expect(document.querySelector('.maestro-menu')).not.toBeNull();
        const answer = await run('maestro', 'кухня');
        expect(answer).toContain('Окна «кухня» нет. Есть:');
        expect(answer).toContain('Мир');
        expect(normalizeName('  Ёлка «МИР» ')).toBe('елка мир');
    });

    it('/maestro-undo asks, then undoes the latest record still standing', async () => {
        expect(await run('maestro-undo')).toBe('Отменять нечего: Maestro здесь пока ничего не менял.');
        fakes.journal.records = [
            record('r3', 'Запомнил, что Офелия рыжая', { undone: true }),
            record('r2', 'Добавил место «Таверна»'),
            record('r1', 'Старое'),
        ];
        env.callGenericPopup.mockResolvedValueOnce(0);
        expect(await run('maestro-undo')).toBe('Оставил как есть: Добавил место «Таверна»');
        expect(fakes.journal.undone).toEqual([]);
        expect(await run('maestro-undo')).toBe('Отменил: Добавил место «Таверна»');
        expect(fakes.journal.undone).toEqual(['r2']);
        const confirmBody = env.callGenericPopup.mock.calls.at(-1)?.[0] as HTMLElement;
        expect(confirmBody.textContent).toContain('«Добавил место «Таверна»»');
        vi.spyOn(fakes.journal, 'undo').mockResolvedValueOnce(false);
        expect(await run('maestro-undo')).toContain('Не получилось отменить «Старое»');
        expect(env.toastr.warning).toHaveBeenCalled();
    });

    it('/maestro-mode names the mode, switches it by id or Russian name, refuses others', async () => {
        const changes: string[] = [];
        env.settings.onChange((path) => changes.push(path));
        expect(await run('maestro-mode')).toBe(
            'Сейчас режим «Сбалансированный». Есть: Экономный, Сбалансированный, Кино.',
        );
        expect(await run('maestro-mode', 'кино')).toContain('Режим «Кино».');
        expect(env.settings.core().mode).toBe('cinema');
        expect(changes).toContain('core.mode');
        await run('maestro-mode', 'economy');
        expect(env.settings.core().mode).toBe('economy');
        expect(await run('maestro-mode', 'турбо')).toBe('Режима «турбо» нет. Есть: Экономный, Сбалансированный, Кино.');
        expect(env.settings.core().mode).toBe('economy');
    });

    it('answer «Maestro отключён» after dispose', async () => {
        ui.dispose();
        expect(await run('maestro', 'мир')).toBe('Maestro отключён.');
    });
});
