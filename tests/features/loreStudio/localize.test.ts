// @vitest-environment happy-dom
// Localization as a user job (plan-2 §8): the runner against a fake Lorebook Localizer API (0.3 with progress,
// queue, stop and timeouts; 0.2 without), and the studio's book header strip built from the job state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { LocalizeEntriesOptions, LocalizeEntriesResult } from '../../../src/adapters/localizer';
import { createI18n } from '../../../src/core/i18n';
import { createUserJobs } from '../../../src/core/jobs';
import type { UserJobsService } from '../../../src/core/jobs';
import type { RenderEntryForm } from '../../../src/features/loreStudio/form-api';
import { userJobs } from '../../../src/features/loreStudio/jobs';
import { bookJobKey, entryJobKey, localizeData, startLocalizeJob } from '../../../src/features/loreStudio/localize-job';
import type { LocalizeRequest } from '../../../src/features/loreStudio/localize-job';
import { LOCALIZE_STRINGS } from '../../../src/features/loreStudio/localize-strings';
import { M23_STRINGS } from '../../../src/features/loreStudio/strings';
import { LoreStudio, defaultStudioSettings } from '../../../src/features/loreStudio/studio';
import type { App } from '../../../src/shared/contracts';
import { createStand, entry, resetDom } from './stand';
import type { Stand } from './stand';

const ALL = ['progress', 'cancel', 'busy', 'timeout'];
const silent = { debug() {}, info() {}, warn() {}, error() {}, scope: () => silent };

interface Call {
    book: string;
    uids: number[];
    args: number;
    options?: LocalizeEntriesOptions;
    resolve(result: LocalizeEntriesResult): void;
    reject(error: unknown): void;
}

function fakeLocalizer(features?: string[]) {
    const calls: Call[] = [];
    const state = { busy: false, protected: false };
    const api = {
        version: 1,
        features,
        buildKeyRegex: () => null,
        buildPlainKeys: () => [],
        cleanForms: () => [],
        isProtectedBook: vi.fn(async () => state.protected),
        busy: vi.fn(() => ({ running: state.busy, by: state.busy ? ('dialog' as const) : undefined })),
        localizeEntries: vi.fn(
            (book: string, uids: number[], ...rest: LocalizeEntriesOptions[]) =>
                new Promise<LocalizeEntriesResult>((resolve, reject) => {
                    calls.push({ book, uids, args: 2 + rest.length, options: rest[0], resolve, reject });
                }),
        ),
    };
    if (!features) {
        delete (api as Partial<typeof api>).features;
        delete (api as Partial<typeof api>).busy;
    }
    const last = () => calls[calls.length - 1]!;
    return { api, calls, state, last };
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/* ================================================================== strings */

describe('localization strings', () => {
    it('have the same keys and placeholders in both languages, with every plural form', () => {
        const { en, ru } = LOCALIZE_STRINGS;
        expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(en)) {
            expect(key.startsWith('m23.job.'), key).toBe(true);
            expect(placeholders(ru[key] ?? ''), key).toEqual(placeholders(text));
            expect(ru[key]?.trim(), key).toBeTruthy();
        }
        for (const base of ['ofEntries', 'keys', 'entries', 'failures', 'cancelled'])
            for (const form of ['one', 'few', 'many']) expect(en[`m23.job.${base}.${form}`]).toBeDefined();
        for (const key of Object.keys(en)) expect(M23_STRINGS.en[key]).toBe(en[key]);
    });
});

/* ================================================================== the runner */

describe('localization job runner', () => {
    let locale: 'en' | 'ru';
    let app: App;
    let jobs: UserJobsService;
    let notices: { text: string; options?: Record<string, unknown> }[];
    let localizerSettings: Record<string, unknown>;

    beforeEach(() => {
        locale = 'en';
        const i18n = createI18n(() => locale);
        i18n.register(M23_STRINGS);
        notices = [];
        localizerSettings = {};
        app = {
            i18n,
            log: silent,
            ui: { notice: (text: string, options?: Record<string, unknown>) => notices.push({ text, options }) },
            adapters: { localizer: { settings: () => localizerSettings } },
        } as unknown as App;
        jobs = createUserJobs({ log: silent, notice: (text, options) => app.ui.notice(text, options) });
    });

    afterEach(() => {
        jobs.dispose();
        vi.useRealTimers();
    });

    const start = (fake: ReturnType<typeof fakeLocalizer>, extra: Partial<LocalizeRequest> = {}) =>
        startLocalizeJob({
            app,
            jobs,
            api: fake.api as unknown as LocalizeRequest['api'],
            scope: 'book',
            book: 'World',
            uids: Array.from({ length: 120 }, (_, index) => index),
            visible: () => true,
            ...extra,
        });
    const job = () => jobs.get(bookJobKey('World'))!;

    it('counts entries with Localizer 0.3: queue, progress with a shrinking total, saving, result', async () => {
        const fake = fakeLocalizer(ALL);
        fake.state.busy = true;
        const order: string[] = [];
        start(fake, {
            titles: { 5: 'Anna', 6: 'Bob' },
            afterRun: () => {
                order.push(`afterRun:${job().state}`);
            },
        });
        expect(job()).toMatchObject({ state: 'active', phase: 'queued', cancellable: true });
        expect(job().label).toBe('Waiting: Lorebook Localizer is busy with another job');
        const call = fake.last();
        expect(call.args).toBe(3);
        expect(call.options?.signal).toBeInstanceOf(AbortSignal);
        expect(call.options?.batchTimeoutMs).toBe(90_000);
        const progress = call.options!.onProgress!;
        progress({ phase: 'queued', done: 0, total: 120 });
        progress({ phase: 'running', done: 0, total: 118 });
        expect(job()).toMatchObject({ phase: 'running', done: 0, total: 118, label: 'Localizing: 0 of 118 entries' });
        progress({ phase: 'running', done: 34, total: 118 });
        expect(job().label).toBe('Localizing: 34 of 118 entries');
        locale = 'ru';
        progress({ phase: 'running', done: 41, total: 41 });
        expect(job().label).toBe('Локализую: 41 из 41 записи');
        progress({ phase: 'running', done: 34, total: 120 });
        expect(job().label).toBe('Локализую: 34 из 120 записей');
        progress({ phase: 'saving', done: 118, total: 118 });
        expect(job()).toMatchObject({ phase: 'saving', label: 'Сохраняю книгу…' });
        call.resolve({
            added: 214,
            entries: 118,
            failures: 2,
            cancelled: false,
            failed: [
                { uid: 5, reason: 'timeout' },
                { uid: 6, reason: 'invalid' },
            ],
        });
        await settle();
        expect(order).toEqual(['afterRun:active']);
        expect(job()).toMatchObject({ state: 'done', warn: true });
        expect(job().summary).toBe('Готово: добавлено 214 ключей в 118 записей; 2 записи не удались');
        expect(localizeData(job().data)).toMatchObject({
            live: true,
            added: 214,
            failed: [
                { uid: 5, reason: 'timeout' },
                { uid: 6, reason: 'invalid' },
            ],
            titles: { 5: 'Anna', 6: 'Bob' },
        });
        expect(notices).toEqual([]);
    });

    it('a second start of the same book is refused while the first runs', () => {
        const fake = fakeLocalizer(ALL);
        expect(start(fake)).not.toBeNull();
        expect(start(fake)).toBeNull();
        expect(fake.api.localizeEntries).toHaveBeenCalledTimes(1);
    });

    it('stop: the Localizer keeps the finished batches and the summary counts them', async () => {
        const fake = fakeLocalizer(ALL);
        start(fake, { visible: () => false });
        const call = fake.last();
        call.options!.onProgress!({ phase: 'running', done: 40, total: 120 });
        expect(jobs.cancel(bookJobKey('World'))).toBe(true);
        expect(call.options?.signal?.aborted).toBe(true);
        expect(job().cancelRequested).toBe(true);
        call.resolve({ added: 70, entries: 38, failures: 2, cancelled: true, failed: [{ uid: 3, reason: 'error' }] });
        await settle();
        expect(job()).toMatchObject({
            state: 'cancelled',
            summary: 'Stopped: 40 of 120 entries processed; added 70 keys',
        });
        // The user stopped it himself: no notice.
        expect(notices).toEqual([]);

        locale = 'ru';
        start(fake);
        jobs.cancel(bookJobKey('World'));
        fake.last().options!.onProgress!({ phase: 'running', done: 40, total: 120 });
        fake.last().resolve({ added: 0, entries: 0, failures: 0, cancelled: true, failed: [] });
        await settle();
        expect(job().summary).toBe('Остановлено: обработано 40 из 120 записей');

        start(fake);
        jobs.cancel(bookJobKey('World'));
        fake.last().reject(new DOMException('The operation was aborted.', 'AbortError'));
        await settle();
        expect(job()).toMatchObject({ state: 'cancelled', summary: 'Остановлено: обработано 0 из 120 записей' });
    });

    it('batch timeouts end in plain words with the Localizer’s own limit', async () => {
        const fake = fakeLocalizer(ALL);
        start(fake, { uids: [1, 2, 3], visible: () => false });
        fake.last().resolve({
            added: 0,
            entries: 0,
            failures: 3,
            cancelled: false,
            failed: [1, 2, 3].map((uid) => ({ uid, reason: 'timeout' as const })),
        });
        await settle();
        expect(job()).toMatchObject({ state: 'failed', error: 'Error: the model did not answer within 90 s' });
        expect(notices).toEqual([
            {
                text: 'Russian keys for «World» — Error: the model did not answer within 90 s',
                options: { urgent: true, level: 'error', action: undefined },
            },
        ]);

        locale = 'ru';
        localizerSettings.requestTimeout = 120;
        start(fake, { uids: [1, 2] });
        expect(fake.last().options?.batchTimeoutMs).toBe(120_000);
        fake.last().resolve({
            added: 0,
            entries: 0,
            failures: 2,
            cancelled: false,
            failed: [
                { uid: 1, reason: 'timeout' },
                { uid: 2, reason: 'invalid' },
            ],
        });
        await settle();
        expect(job().error).toBe('Ошибка: модель не перевела ни одной записи');
        expect(localizeData(job().data)).toMatchObject({ reason: 'allFailed', timeoutSeconds: 120 });
    });

    it('maps Localizer rejections to plain reasons and keeps its message for the details', async () => {
        const fake = fakeLocalizer(ALL);
        const cases: [string, string][] = [
            ['localizeEntries: no API connection', 'Error: there is no connection to the model'],
            [
                'localizeEntries: "Pack" is a BunnyMo book or pack, those are never localized',
                'Error: Lorebook Localizer never touches BunnyMo books',
            ],
            [
                'localizeEntries: lorebook "World" not found',
                'Error: the book was not found — was it renamed or deleted?',
            ],
            [
                'localizeEntries: unknown language id "xx"',
                'Error: no translation language is chosen in Lorebook Localizer',
            ],
            [
                'localizeEntries: the connection profile cannot be used: gone',
                'Error: the connection profile chosen in Lorebook Localizer does not work',
            ],
            ['something odd', 'Error: Lorebook Localizer could not finish'],
        ];
        for (const [message, text] of cases) {
            start(fake);
            fake.last().reject(new Error(message));
            await settle();
            expect(job().error).toBe(text);
            expect(localizeData(job().data)?.message).toBe(message);
        }
    });

    it('an older Localizer gets the plain call; the job shows the elapsed time and cannot be stopped', async () => {
        vi.useFakeTimers();
        const fake = fakeLocalizer();
        start(fake, { uids: [1, 2, 3] });
        expect(fake.last().args).toBe(2);
        expect(fake.api.localizeEntries).toHaveBeenCalledWith('World', [1, 2, 3]);
        expect(job()).toMatchObject({ cancellable: false, phase: 'running', label: 'Working… 0:00' });
        expect(job().total).toBeUndefined();
        expect(localizeData(job().data)?.live).toBe(false);
        vi.advanceTimersByTime(42_000);
        expect(job().label).toBe('Working… 0:42');
        expect(jobs.cancel(bookJobKey('World'))).toBe(false);
        fake.last().resolve({ added: 3, entries: 2, failures: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(job()).toMatchObject({ state: 'done', summary: 'Done: added 3 keys to 2 entries; 1 entry failed' });
        expect(localizeData(job().data)?.failed).toEqual([]);

        start(fake, { uids: [1, 2] });
        fake.last().resolve({ added: 0, entries: 0, failures: 0 });
        await vi.advanceTimersByTimeAsync(0);
        expect(job().summary).toBe('Done: no new keys were needed');
    });

    it('entry jobs have their own key, title and compact texts', async () => {
        const fake = fakeLocalizer(ALL);
        startLocalizeJob({
            app,
            jobs,
            api: fake.api as unknown as LocalizeRequest['api'],
            scope: 'entry',
            book: 'World',
            uids: [7],
            titles: { 7: 'Anna' },
        });
        const key = entryJobKey('World', 7);
        expect(jobs.get(key)).toMatchObject({ title: 'Russian keys for «Anna»', label: 'Translating the keys… 0:00' });
        fake.last().resolve({ added: 1, entries: 1, failures: 0, cancelled: false, failed: [] });
        await settle();
        expect(jobs.get(key)?.summary).toBe('Done: added 1 key');
        expect(notices.map((notice) => notice.text)).toEqual(['Russian keys for «Anna» — Done: added 1 key']);
        expect(notices[0]?.options?.urgent).toBe(false);
    });
});

/* ================================================================== the studio */

describe('Lore Studio localization strip', () => {
    let s: Stand;
    let off: () => void;
    let studio: LoreStudio;
    let fake: ReturnType<typeof fakeLocalizer>;

    const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
    const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
    const strip = () => q('.maestro-m23-job');
    const trigger = () => q<HTMLButtonElement>('.maestro-m23-localize');
    const buttonIn = (root: ParentNode | null, text: string) =>
        [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
            (node) => node.textContent?.trim() === text,
        );

    async function openWorld(): Promise<void> {
        studio.open('World');
        await wait();
    }

    async function startFromHeader(): Promise<void> {
        trigger()!.click();
        await wait();
    }

    beforeEach(() => {
        resetDom();
        s = createStand();
        off = s.store.install();
        s.addBook('World', {
            1: entry(1, { comment: 'Anna', key: ['Anna'] }),
            2: entry(2, { comment: 'Bob', key: ['Bob'] }),
        });
        fake = fakeLocalizer(ALL);
        (s.app.adapters as unknown as Record<string, unknown>).localizer = {
            api: () => fake.api,
            settings: () => ({}),
        };
        studio = new LoreStudio({
            app: s.app,
            log: s.app.log,
            store: s.store,
            renderForm: vi.fn<RenderEntryForm>(() => () => {}) as Mock<RenderEntryForm>,
            settings: defaultStudioSettings(),
            saveSettings: vi.fn(),
            openClassic: vi.fn(async () => true),
        });
    });

    afterEach(() => {
        studio.close();
        off();
    });

    it('replaces the button with a live strip that survives re-renders and never starts a twin', async () => {
        await openWorld();
        expect(trigger()?.hidden).toBe(false);
        expect(strip()).toBeNull();
        await startFromHeader();
        expect(fake.calls.map((call) => call.uids)).toEqual([[1, 2]]);
        expect(trigger()?.hidden).toBe(true);
        expect(strip()?.textContent).toContain('Localizing: 0 of 2 entries');
        expect(buttonIn(strip(), 'Stop')).toBeDefined();
        expect(strip()?.querySelector('.maestro-progress')?.getAttribute('aria-valuenow')).toBe('0');

        // Progress redraws the strip in place: the entry list (and its scroll) stays.
        const list = q('.maestro-m23-entry-list');
        fake.last().options!.onProgress!({ phase: 'running', done: 1, total: 2 });
        expect(strip()?.textContent).toContain('Localizing: 1 of 2 entries');
        expect(q('.maestro-m23-entry-list')).toBe(list);

        // The Localizer saves the book: the studio re-renders from the store; the button stays replaced.
        await s.emit('WORLDINFO_UPDATED', 'World', s.book('World'));
        await wait();
        expect(q('.maestro-m23-entry-list')).not.toBe(list);
        expect(trigger()?.hidden).toBe(true);
        expect(strip()?.textContent).toContain('Localizing: 1 of 2 entries');
        trigger()!.click();
        await wait();
        expect(fake.api.localizeEntries).toHaveBeenCalledTimes(1);
    });

    it('keeps running after the studio closes, reports once and shows the result when reopened', async () => {
        await openWorld();
        await startFromHeader();
        studio.close();
        fake.last().resolve({ added: 2, entries: 2, failures: 0, cancelled: false, failed: [] });
        await wait();
        expect(s.ui.notices.map((notice) => notice.text)).toEqual([
            'Russian keys for «World» — Done: added 2 keys to 2 entries',
        ]);
        expect(s.ui.notices[0]?.options?.urgent).toBe(false);
        await openWorld();
        expect(strip()?.textContent).toContain('Done: added 2 keys to 2 entries');
        expect(trigger()?.hidden).toBe(true);
        buttonIn(strip(), 'Hide')!.click();
        await wait();
        expect(strip()).toBeNull();
        expect(trigger()?.hidden).toBe(false);
        expect(userJobs(s.app).get(bookJobKey('World'))).toBeUndefined();
    });

    it('stops on request and retries only the failed entries', async () => {
        await openWorld();
        await startFromHeader();
        buttonIn(strip(), 'Stop')!.click();
        await wait();
        expect(fake.last().options?.signal?.aborted).toBe(true);
        expect(strip()?.textContent).toContain('Stopping after the current batch…');
        expect(buttonIn(strip(), 'Stop')).toBeUndefined();
        fake.last().resolve({ added: 0, entries: 0, failures: 0, cancelled: true, failed: [] });
        await wait();
        expect(strip()?.textContent).toContain('Stopped: 0 of 2 entries processed');
        expect(s.ui.notices).toEqual([]);

        buttonIn(strip(), 'Hide')!.click();
        await wait();
        await startFromHeader();
        fake.last().resolve({
            added: 3,
            entries: 1,
            failures: 1,
            cancelled: false,
            failed: [{ uid: 2, reason: 'invalid' }],
        });
        await wait();
        expect(strip()?.textContent).toContain('Done: added 3 keys to 1 entry; 1 entry failed');
        expect(strip()?.querySelector('details')?.textContent).toContain(
            '«Bob»: the model gave no usable Russian keys',
        );
        buttonIn(strip(), 'Retry the failed ones')!.click();
        await wait();
        expect(fake.calls.map((call) => call.uids)).toEqual([[1, 2], [1, 2], [2]]);
        expect(strip()?.textContent).toContain('Localizing: 0 of 1 entry');
    });

    it('an error offers a retry of the whole run', async () => {
        await openWorld();
        await startFromHeader();
        fake.last().reject(new Error('localizeEntries: no API connection'));
        await wait();
        expect(strip()?.classList.contains('maestro-m23-job-failed')).toBe(true);
        expect(strip()?.textContent).toContain('Error: there is no connection to the model');
        // The studio shows it: no notice.
        expect(s.ui.notices).toEqual([]);
        buttonIn(strip(), 'Retry')!.click();
        await wait();
        expect(fake.calls.map((call) => call.uids)).toEqual([
            [1, 2],
            [1, 2],
        ]);
    });

    it('an older Localizer: indeterminate bar, the hint about 0.3, no Stop', async () => {
        fake = fakeLocalizer();
        await openWorld();
        await startFromHeader();
        expect(fake.last().args).toBe(2);
        expect(strip()?.textContent).toMatch(/Working… 0:0\d/);
        expect(strip()?.querySelector('.maestro-progress-indeterminate')).not.toBeNull();
        expect(strip()?.textContent).toContain('Lorebook Localizer 0.3 shows a live count');
        expect(buttonIn(strip(), 'Stop')).toBeUndefined();
        fake.last().resolve({ added: 1, entries: 1, failures: 0 });
        await wait();
        expect(strip()?.textContent).toContain('Done: added 1 key to 1 entry');
    });

    it('a BunnyMo book is refused before asking', async () => {
        fake.state.protected = true;
        await openWorld();
        s.callGenericPopup.mockClear();
        await startFromHeader();
        expect(s.callGenericPopup).not.toHaveBeenCalled();
        expect(fake.api.localizeEntries).not.toHaveBeenCalled();
        expect(s.ui.notices.at(-1)?.text).toBe('Lorebook Localizer does not touch this book (BunnyMo).');
    });
});
