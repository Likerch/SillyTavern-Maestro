// @vitest-environment happy-dom
// Jobs the user started, seen outside their own window (plan-2 §8): the Tasks tab section and the top-bar ring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserJobs } from '../../src/core/jobs';
import type { UserJobsService } from '../../src/core/jobs';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { resetRegistries } from '../../src/ui/views/registries';
import { buildStDom, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes } from '../helpers/ui-fakes';

let env: UiTestEnv;
let ui: UiImpl;
let jobs: UserJobsService;

const body = () => document.querySelector<HTMLElement>('.maestro-pult-body')!;
const top = () => document.getElementById('maestro-topbar')!;
const toggle = () => top().querySelector<HTMLElement>('.maestro-topbar-toggle')!;
const buttonByText = (text: string, root: ParentNode = document) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);
const flush = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
    resetRegistries();
    buildStDom();
    env = installUiEnv('ru');
    env.settings.core().firstRunDone = true;
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
    jobs = createUserJobs({ log: env.log });
    ui.registerCoreViews(coreFakes(env, { jobs }));
});

afterEach(() => {
    ui.dispose();
    jobs.dispose();
});

describe('user jobs outside their window', () => {
    it('the Tasks tab lists running and finished jobs with progress, Stop, Open and Hide', async () => {
        const open = vi.fn();
        const running = jobs.start({
            key: 'localize:World',
            title: 'Русские ключи для книги «World»',
            cancellable: true,
            open: { label: 'Открыть', run: open },
        })!;
        running.progress(34, 120, 'Локализую: 34 из 120 записей');
        jobs.start({ key: 'localize-entry:1:World', title: 'Русские ключи для записи «Anna»' })!.fail(
            'Ошибка: нет подключения к модели',
        );
        ui.openPult('tasks');
        const items = () => [...body().querySelectorAll<HTMLElement>('.maestro-job')];
        expect(items().map((item) => item.dataset.key)).toEqual(['localize:World', 'localize-entry:1:World']);
        expect(items()[0]?.textContent).toContain('Локализую: 34 из 120 записей');
        expect(items()[0]?.querySelector('.maestro-progress')?.getAttribute('aria-valuenow')).toBe('34');
        expect(items()[1]?.textContent).toContain('Ошибка: нет подключения к модели');
        expect(buttonByText('Остановить', items()[1])).toBeUndefined();

        buttonByText('Открыть', items()[0])!.click();
        expect(open).toHaveBeenCalledTimes(1);
        buttonByText('Остановить', items()[0])!.click();
        expect(running.signal.aborted).toBe(true);
        await flush();
        expect(items()[0]?.textContent).toContain('Останавливаю после текущего шага…');
        expect(buttonByText('Остановить', items()[0])).toBeUndefined();

        // Changes redraw the open tab without waiting for the poll.
        running.finish('Остановлено: обработано 40 из 120 записей', { cancelled: true });
        await flush();
        expect(items()[0]?.textContent).toContain('Остановлено: обработано 40 из 120 записей');
        buttonByText('Скрыть', items()[0])!.click();
        await flush();
        expect(items().map((item) => item.dataset.key)).toEqual(['localize-entry:1:World']);
    });

    it('says so when nothing runs', () => {
        ui.openPult('tasks');
        expect(body().textContent).toContain('Сейчас ничего из запущенного тобой не идёт.');
    });

    it('the top-bar icon gets a progress ring while a job runs, with the job in its tooltip', () => {
        expect(top().classList.contains('maestro-topbar-busy')).toBe(false);
        const job = jobs.start({ key: 'a', title: 'Русские ключи для книги «World»' })!;
        expect(top().classList.contains('maestro-topbar-busy')).toBe(true);
        expect(top().classList.contains('maestro-topbar-indeterminate')).toBe(true);
        job.progress(30, 120, 'Локализую: 30 из 120 записей');
        expect(top().classList.contains('maestro-topbar-indeterminate')).toBe(false);
        expect(top().style.getPropertyValue('--maestro-job-progress')).toBe('0.25');
        expect(toggle().title).toBe(
            'Maestro — открыть пульт · Русские ключи для книги «World»: Локализую: 30 из 120 записей',
        );
        jobs.start({ key: 'b', title: 'Другая' });
        expect(top().classList.contains('maestro-topbar-indeterminate')).toBe(true);
        expect(toggle().title).toBe('Maestro — открыть пульт · идут твои задачи: 2');
        job.finish('Готово');
        expect(top().classList.contains('maestro-topbar-busy')).toBe(true);
        // No extra icons in the top bar: the ring is drawn on Maestro's own toggle.
        expect(document.querySelectorAll('#top-settings-holder .maestro-topbar').length).toBe(1);
    });

    it('drops the ring when the last job ends and when the UI is disposed', () => {
        const job = jobs.start({ key: 'a', title: 'A' })!;
        job.finish('Готово');
        expect(top().classList.contains('maestro-topbar-busy')).toBe(false);
        expect(toggle().title).toBe('Maestro — открыть пульт');
        jobs.start({ key: 'b', title: 'B' });
        ui.dispose();
        expect(document.getElementById('maestro-topbar')).toBeNull();
    });
});
