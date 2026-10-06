// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import { createUi, registerProfileTask, registerSettingsAction } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { resetRegistries } from '../../src/ui/views/registries';
import { UI_STRINGS } from '../../src/ui/views/strings';
import { buildStDom, FakePopup, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes, fakeAutonomy, fakeCost, FakeModules, fakeModule, fakeTasks, inboxCard } from '../helpers/ui-fakes';
import type { CoreFakes } from '../helpers/ui-fakes';

let env: UiTestEnv;
let ui: UiImpl;
let fakes: CoreFakes;

const body = () => document.querySelector<HTMLElement>('.maestro-pult-body')!;
const buttonByText = (text: string, root: ParentNode = document) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function start(overrides: Partial<CoreFakes> = {}): void {
    fakes = coreFakes(env, overrides);
    ui.registerCoreViews(fakes);
}

beforeEach(() => {
    resetRegistries();
    buildStDom();
    env = installUiEnv('ru');
    env.settings.core().firstRunDone = true;
    env.i18n.register({ en: { 'test.m8': 'Revision' }, ru: { 'test.m8': 'Ревизия' } });
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
});

afterEach(() => {
    ui.dispose();
    vi.useRealTimers();
});

describe('core views', () => {
    it('registers the six core tabs in plan order', () => {
        start();
        ui.openPult();
        const ids = [...document.querySelectorAll<HTMLElement>('.maestro-tab')].map((node) => node.dataset.tab);
        expect(ids).toEqual(['overview', 'inbox', 'health', 'tasks', 'journal', 'settings']);
        const labels = [...document.querySelectorAll('.maestro-tab-label')].map((node) => node.textContent);
        expect(labels).toEqual(['Обзор', 'Входящие', 'Здоровье', 'Задачи', 'Журнал', 'Настройки']);
    });

    it('every ui string exists in both languages', () => {
        const en = Object.keys(UI_STRINGS.en).sort();
        const ru = Object.keys(UI_STRINGS.ru).sort();
        expect(ru).toEqual(en);
        for (const key of en) expect(UI_STRINGS.ru[key]?.trim()).toBeTruthy();
    });
});

describe('Overview', () => {
    it('groups capability lamps by neighbour, lists modules, shows cost and mode', () => {
        env.caps.items.push(
            { id: 'des.tracker', ok: true },
            { id: 'des.lore', ok: false, detail: 'no API' },
            { id: 'qvink.memory', ok: true },
        );
        start({
            modules: new FakeModules([fakeModule('canon', { id: 'M6', titleKey: 'test.m8', stage: 2 })]),
            cost: fakeCost({ todayUsd: 1.5, todayBySource: { main: 1.2, maestro: 0.3 }, backgroundTodayUsd: 0.3 }),
        });
        env.settings.core().backgroundDailyCapUsd = 1;
        ui.openPult('overview');
        const rows = [...body().querySelectorAll('.maestro-stack-row')];
        expect(rows.map((row) => row.querySelector('.maestro-stack-name')?.textContent)).toEqual([
            "Doom's Enhancement Suite",
            'Qvink Memory',
        ]);
        expect(rows[0]?.querySelector('.maestro-lamp-warn')).not.toBeNull();
        expect(rows[0]?.querySelector('li')?.textContent).toBe('des.lore — no API');
        expect(body().textContent).toContain('Ревизия');
        expect(body().textContent).toMatch(/1,50\s\$/);
        expect(body().textContent).toContain('Основной чат');
        expect(body().querySelector('.maestro-segment.maestro-on')?.textContent).toBe('Сбалансированный');
    });

    it('switches the mode through settings and notifies', () => {
        start();
        const notified: string[] = [];
        env.settings.onChange((path) => notified.push(path));
        ui.openPult('overview');
        [...body().querySelectorAll<HTMLButtonElement>('.maestro-segment')]
            .find((node) => node.textContent === 'Кино')
            ?.click();
        expect(env.settings.core().mode).toBe('cinema');
        expect(notified).toContain('core.mode');
    });

    it('shows the group chat banner', () => {
        env.group.value = true;
        start();
        ui.openPult('overview');
        expect(body().querySelector('.maestro-banner')?.textContent).toContain('Групповые чаты не поддерживаются');
    });

    it('re-renders when the cost changes (coalesced)', async () => {
        vi.useFakeTimers();
        const summary = { todayUsd: 0 };
        const cost = fakeCost();
        cost.summary = () => ({ todayUsd: summary.todayUsd, todayBySource: {}, backgroundTodayUsd: 0, anlasToday: 0 });
        start({ cost });
        ui.openPult('overview');
        summary.todayUsd = 2;
        cost.fire();
        cost.fire();
        await vi.advanceTimersByTimeAsync(300);
        expect(body().textContent).toMatch(/2,00\s\$/);
    });
});

describe('Inbox', () => {
    it('badge equals inbox.count() and follows changes', () => {
        start();
        fakes.inbox.set([inboxCard('1'), inboxCard('2')]);
        const badge = document.querySelector<HTMLElement>('#maestro-topbar .maestro-topbar-badge');
        expect(badge?.textContent).toBe('2');
        fakes.inbox.set([]);
        expect(badge?.hidden).toBe(true);
    });

    it('renders cards with module title, diff and source link', () => {
        start({ modules: new FakeModules([fakeModule('revision', { id: 'M8', titleKey: 'test.m8' })]) });
        fakes.inbox.set([inboxCard('1', { sourceMessage: 2, description: 'Новый факт' })]);
        ui.openPult('inbox');
        const card = body().querySelector('.maestro-inbox-card')!;
        expect(card.querySelector('.maestro-card-title')?.textContent).toBe('Card 1');
        expect(card.textContent).toContain('Ревизия');
        expect(card.querySelector('del')?.textContent).toBe('Rome');
        expect(card.querySelector('ins')?.textContent).toBe('Paris');
        buttonByText('Сообщение №2', card)?.click();
        expect(FakePopup.open()).toHaveLength(0);
        expect(document.querySelector('#chat .mes[mesid="2"]')?.classList.contains('maestro-flash')).toBe(true);
    });

    it('accepts, rejects and snoozes for a day', async () => {
        start();
        fakes.inbox.set([inboxCard('1'), inboxCard('2'), inboxCard('3')]);
        ui.openPult('inbox');
        const cardById = (title: string) =>
            [...body().querySelectorAll('.maestro-inbox-card')].find((node) => node.textContent?.includes(title))!;
        buttonByText('Принять', cardById('Card 1'))?.click();
        await flush();
        buttonByText('Отклонить', cardById('Card 2'))?.click();
        await flush();
        buttonByText('Завтра', cardById('Card 3'))?.click();
        await flush();
        expect(fakes.inbox.accepted).toEqual(['1']);
        expect(fakes.inbox.rejected).toEqual(['2']);
        expect(fakes.inbox.snoozed).toEqual([{ id: '3', ms: 86_400_000 }]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(body().querySelector('.maestro-empty')?.textContent).toBe('Во «Входящих» пусто.');
    });

    it('reports a stale card instead of applying it', async () => {
        start();
        fakes.inbox.set([inboxCard('1')]);
        fakes.inbox.stale.add('1');
        ui.openPult('inbox');
        buttonByText('Принять')?.click();
        await flush();
        ui.openPult('overview');
        expect(body().textContent).toContain('«Card 1» устарело');
    });

    it('accepts all visible actionable cards, skipping deferred ones', async () => {
        start();
        fakes.inbox.set([inboxCard('1'), inboxCard('2', { deferred: true }), inboxCard('3')]);
        fakes.inbox.stale.add('3');
        ui.openPult('inbox');
        const deferredAccept = [...body().querySelectorAll('.maestro-inbox-card')]
            .find((node) => node.textContent?.includes('Card 2'))
            ?.querySelector<HTMLButtonElement>('.maestro-btn-primary');
        expect(deferredAccept?.disabled).toBe(true);
        buttonByText('Принять все (2)')?.click();
        await flush();
        expect(fakes.inbox.accepted).toEqual(['1']);
        ui.openPult('overview');
        expect(body().textContent).toContain('Принял 1. Пропустил 1: с тех пор всё изменилось.');
    });
});

describe('Journal', () => {
    it('lists records newest first, undoes and shows autonomy stats', async () => {
        start({
            autonomy: fakeAutonomy([{ kind: 'canon.fact', accepted: 4, edited: 1, rejected: 0, undone: 2, streak: 3 }]),
        });
        fakes.journal.records = [
            { id: 'old', module: 'M8', kind: 'canon.fact', summary: 'Старое', changes: [], at: 1, chatId: 'chat-1' },
            { id: 'new', module: 'M8', kind: 'canon.fact', summary: 'Новое', changes: [], at: 2, chatId: 'chat-1' },
            {
                id: 'done',
                module: 'M9',
                kind: 'chronicle',
                summary: 'Откаченное',
                changes: [],
                at: 0,
                chatId: 'chat-1',
                undone: true,
            },
        ];
        ui.openPult('journal');
        const rows = [...body().querySelectorAll('.maestro-journal-row')];
        expect(rows.map((row) => row.querySelector('.maestro-journal-summary')?.textContent)).toEqual([
            'Новое',
            'Старое',
            'Откаченное',
        ]);
        expect(rows[2]?.querySelector('button')?.disabled).toBe(true);
        rows[0]?.querySelector('button')?.click();
        await flush();
        expect(fakes.journal.undone).toEqual(['new']);
        const stats = [...body().querySelectorAll('.maestro-table tbody td')].map((cell) => cell.textContent);
        expect(stats).toEqual(['canon.fact', '4', '1', '0', '2', '3']);
    });

    it('filters by module', () => {
        start();
        fakes.journal.records = [
            { id: '1', module: 'M8', kind: 'k', summary: 'A', changes: [], at: 1, chatId: null },
            { id: '2', module: 'M9', kind: 'k', summary: 'B', changes: [], at: 2, chatId: null },
        ];
        ui.openPult('journal');
        const filter = body().querySelector<HTMLSelectElement>('select')!;
        filter.value = 'M9';
        filter.dispatchEvent(new Event('change'));
        expect([...body().querySelectorAll('.maestro-journal-summary')].map((node) => node.textContent)).toEqual(['B']);
    });
});

describe('Health and Tasks', () => {
    it('runs registered checks on open and offers Fix', async () => {
        start();
        const fix = vi.fn(async () => {});
        let status: 'error' | 'ok' = 'error';
        ui.addHealthCheck({
            id: 'tracker',
            module: 'M3',
            titleKey: 'test.m8',
            run: async () => (status === 'error' ? { status, message: 'Сломан', fix } : { status }),
        });
        ui.openPult('health');
        await flush();
        const check = body().querySelector('.maestro-check')!;
        expect(check.classList.contains('maestro-check-error')).toBe(true);
        expect(check.textContent).toContain('Сломан');
        status = 'ok';
        buttonByText('Исправить', check)?.click();
        await flush();
        await flush();
        expect(fix).toHaveBeenCalledTimes(1);
        expect(body().querySelector('.maestro-check')?.classList.contains('maestro-check-ok')).toBe(true);
    });

    it('lists tasks with translated states and kicks the queue', () => {
        const tasks = fakeTasks([
            { id: '1', kind: 'revision', payload: {}, state: 'failed', attempts: 3, createdAt: 1, error: '429' },
            { id: '2', kind: 'backstage', payload: {}, state: 'running', attempts: 1, createdAt: 2 },
        ]);
        start({ tasks });
        ui.openPult('tasks');
        const rows = [...body().querySelectorAll('.maestro-table tbody tr')];
        expect(rows.map((row) => row.querySelector('td')?.textContent)).toEqual(['backstage', 'revision']);
        expect(rows[1]?.textContent).toContain('Сбой');
        expect(rows[1]?.textContent).toContain('429');
        buttonByText('Запустить сейчас')?.click();
        expect(tasks.kicks).toBe(1);
    });
});

describe('Settings', () => {
    it('changes the language and relocalizes the pult', () => {
        start();
        ui.dispose();
        // A UI whose i18n follows the setting, as in app.ts.
        const i18n = createI18n(() => (env.settings.core().uiLanguage === 'en' ? 'en' : 'ru'));
        ui = createUi({ host: env.host, i18n, settings: env.settings, log: env.log });
        ui.mount();
        ui.registerCoreViews({ ...fakes, i18n });
        ui.openPult('settings');
        const language = body().querySelector<HTMLSelectElement>('select')!;
        language.value = 'en';
        language.dispatchEvent(new Event('change'));
        expect(env.settings.core().uiLanguage).toBe('en');
        expect(document.querySelector('.maestro-tab[data-tab="settings"] .maestro-tab-label')?.textContent).toBe(
            'Settings',
        );
        expect(document.querySelector('#maestro-ext-settings .maestro-ext-open')?.textContent).toBe('Open Maestro');
    });

    it('edits budgets, profiles per task and autonomy levels', () => {
        registerProfileTask('revision', 'test.m8');
        start({
            autonomy: fakeAutonomy([{ kind: 'canon.fact', accepted: 0, edited: 0, rejected: 0, undone: 0, streak: 0 }]),
        });
        ui.openPult('settings');
        const cap = body().querySelector<HTMLInputElement>('input[type=number]')!;
        cap.value = '0.75';
        cap.dispatchEvent(new Event('change'));
        expect(env.settings.core().backgroundDailyCapUsd).toBe(0.75);

        const selects = [...body().querySelectorAll<HTMLSelectElement>('select')];
        const byLabel = (label: string) => selects.find((node) => node.getAttribute('aria-label') === label)!;
        const revision = byLabel('Ревизия');
        expect([...revision.options].map((option) => option.textContent)).toEqual(['Как основной', 'Profile 1']);
        revision.value = 'p1';
        revision.dispatchEvent(new Event('change'));
        expect(env.settings.core().profiles).toEqual({ revision: 'p1' });
        revision.value = '';
        revision.dispatchEvent(new Event('change'));
        expect(env.settings.core().profiles).toEqual({});

        const autonomy = byLabel('canon.fact');
        autonomy.value = 'inbox';
        autonomy.dispatchEvent(new Event('change'));
        expect(env.settings.core().autonomy).toEqual({ 'canon.fact': 'inbox' });
    });

    it('toggles modules through the module manager', async () => {
        const modules = new FakeModules([fakeModule('canon', { id: 'M6', titleKey: 'test.m8' })]);
        start({ modules });
        ui.openPult('settings');
        const toggle = [...body().querySelectorAll<HTMLLabelElement>('.maestro-module-row label')][0]!;
        const input = toggle.querySelector('input')!;
        input.checked = false;
        input.dispatchEvent(new Event('change'));
        await flush();
        expect(modules.disable).toHaveBeenCalledWith('canon');
    });

    it('calls registered data actions and explains missing ones', async () => {
        start();
        ui.openPult('settings');
        buttonByText('Подготовить к отключению')?.click();
        expect(env.toastr.info).toHaveBeenCalledWith(
            'Пока недоступно: это действие появится в следующих версиях.',
            'Maestro',
            expect.anything(),
        );
        const run = vi.fn();
        registerSettingsAction('prepareDisable', 'ui.settings.prepareDisable', run);
        const cleanup = vi.fn();
        const off = registerSettingsAction('cleanup', 'test.m8', cleanup);
        expect(buttonByText('Ревизия')).toBeDefined();
        buttonByText('Подготовить к отключению')?.click();
        buttonByText('Ревизия')?.click();
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
        off();
        expect(buttonByText('Ревизия')).toBeUndefined();
    });
});

describe('First-run wizard', () => {
    it('opens after APP_READY when the first run is not done and walks through sorted steps', async () => {
        vi.useFakeTimers();
        env.settings.core().firstRunDone = false;
        const order: string[] = [];
        ui.addWizardStep({
            id: 'cap',
            order: 50,
            titleKey: 'test.m8',
            render: (node, done) => (order.push('cap'), node.append('cap'), done()),
        });
        ui.addWizardStep({
            id: 'stack',
            order: 10,
            titleKey: 'test.m8',
            render: (node) => (order.push('stack'), node.append('stack')),
        });
        await env.host.events.emit('APP_READY');
        expect(FakePopup.open()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(2000);
        const wizard = FakePopup.open()[0]!;
        expect(wizard.dlg.classList.contains('maestro-wizard-dialog')).toBe(true);
        expect(wizard.dlg.querySelector('.maestro-wizard-counter')?.textContent).toBe('Шаг 1 из 3');
        const next = () => wizard.dlg.querySelector<HTMLButtonElement>('.maestro-wizard-next')!;
        expect(next().textContent).toBe('Далее');
        next().click();
        expect(order).toEqual(['stack']);
        expect(next().textContent).toBe('Пропустить');
        next().click();
        expect(order).toEqual(['stack', 'cap']);
        expect(next().textContent).toBe('Готово');
        next().click();
        expect(env.settings.core().firstRunDone).toBe(true);
        expect(FakePopup.open()).toHaveLength(0);
    });

    it('does not open when the first run is done; can be run again from Settings', () => {
        start();
        expect(ui.runFirstRunWizardIfNeeded()).toBe(false);
        ui.openPult('settings');
        buttonByText('Запустить мастер первого запуска снова')?.click();
        expect(FakePopup.open().some((popup) => popup.dlg.classList.contains('maestro-wizard-dialog'))).toBe(true);
    });

    it('"Skip setup" marks the first run done', () => {
        env.settings.core().firstRunDone = false;
        expect(ui.runFirstRunWizardIfNeeded()).toBe(true);
        buttonByText('Пропустить настройку')?.click();
        expect(env.settings.core().firstRunDone).toBe(true);
    });
});
