// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorModule } from '../../../src/features/doctor';
import type { DoctorApi } from '../../../src/features/doctor';
import { wizardModule } from '../../../src/features/wizard';
import type { WizardSettings } from '../../../src/features/wizard';
import { onNext } from '../../../src/features/wizard/leave';
import type { MaestroModule } from '../../../src/shared/contracts';
import { Wizard } from '../../../src/ui/views/wizard';
import { clearScripts, silentLog } from '../../helpers/adapters-host';
import { storedBook } from '../../helpers/doctor-entries';
import { FakeRules, createDoctorStand, fakeGuardian, fakeLoreJournal, flush } from '../../helpers/doctor-app';
import type { DoctorStand } from '../../helpers/doctor-app';
import { message } from '../../helpers/st-mock';
import { FakePopup, POPUP_TYPE } from '../../helpers/ui-env';

let s: DoctorStand;
let stop: () => Promise<void>;
const extraStops: (() => Promise<void>)[] = [];

beforeEach(async () => {
    document.body.innerHTML = '';
    FakePopup.instances = [];
    s = createDoctorStand('ru');
    s.i18n.register({
        en: {},
        ru: {
            'rule.role.assistantToSystem': 'Роль assistant → system',
            'rule.role.assistantToSystem.d': 'Записи с ролью assistant на глубине получают роль system.',
            'rule.tags.show': 'Показ тегов BunnyMo',
            'rule.ck.button': 'Кнопка векторизации CK',
            'rule.book.cap': 'Лимит рекурсии и потолок книги',
        },
    });
    stop = await s.start(wizardModule);
});

afterEach(async () => {
    for (const extra of extraStops.splice(0)) await extra();
    await stop();
    clearScripts();
});

const settings = () => s.settings.module<WizardSettings>('wizard');
const step = (id: string) => s.ui.steps.find((item) => item.id === id)!;
const buttonNamed = (root: ParentNode, text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);

/** Renders a step; with `shell` it sits inside a minimal wizard shell with the forward button. */
function render(
    id: string,
    shell = false,
): { container: HTMLElement; done: ReturnType<typeof vi.fn>; next: HTMLButtonElement | null } {
    const container = document.createElement('div');
    let next: HTMLButtonElement | null = null;
    if (shell) {
        const root = document.createElement('div');
        root.className = 'maestro-wizard';
        next = document.createElement('button');
        next.className = 'maestro-wizard-next';
        root.append(container, next);
        document.body.appendChild(root);
    } else {
        document.body.appendChild(container);
    }
    const done = vi.fn();
    step(id).render(container, done);
    return { container, done, next };
}

const RULES = [
    { id: 'role.assistantToSystem', kind: 'lore' as const, enabledByDefault: true },
    { id: 'tags.show', kind: 'display' as const, enabledByDefault: true },
    { id: 'ck.button', kind: 'ui' as const, enabledByDefault: false },
    { id: 'neighbour.x', kind: 'neighbour' as const },
    { id: 'later', stage: 3 },
    { id: 'book.cap', kind: 'lore' as const, enabledByDefault: true },
];

describe('W1 registration', () => {
    it('registers seven steps after the welcome step, in plan order', () => {
        expect(s.ui.steps.map((item) => [item.id, item.order])).toEqual([
            ['w1.stack', 20],
            ['w1.macros', 30],
            ['w1.baseline', 40],
            ['w1.findings', 50],
            ['w1.rules', 60],
            ['w1.background', 70],
            ['w1.oldChats', 80],
        ]);
        expect(s.ui.steps.map((item) => s.i18n.t(item.titleKey))).toEqual([
            'Стек',
            'Движок макросов',
            'Эталон настроек',
            'Регексы и находки',
            'Правила',
            'Фоновые задачи',
            'Старые чаты',
        ]);
        expect(settings()).toEqual({ oldChatsPolicy: 'fromNow', bookCaps: {} });
    });

    it('fits the registry list without casts', () => {
        const registry: MaestroModule[] = [doctorModule, wizardModule];
        expect(registry.map((module) => [module.id, module.key, module.stage])).toEqual([
            ['M5', 'doctor', 1],
            ['W1', 'wizard', 1],
        ]);
    });

    it('has every string in both languages and leaves nothing on disable', async () => {
        const en = Object.keys(wizardModule.i18n!.en).sort();
        expect(Object.keys(wizardModule.i18n!.ru).sort()).toEqual(en);
        for (const key of en) expect(wizardModule.i18n!.ru[key]?.trim()).toBeTruthy();
        expect(s.ui.styles.has('w1-wizard')).toBe(true);
        await stop();
        stop = async () => {};
        expect(s.ui.steps).toEqual([]);
        expect(s.ui.styles.has('w1-wizard')).toBe(false);
    });
});

describe('step 1: stack', () => {
    it('lists the neighbours and says when everything is supported', async () => {
        const { container, done } = render('w1.stack');
        expect(done).toHaveBeenCalled();
        const names = [...container.querySelectorAll<HTMLElement>('[data-neighbour]')].map(
            (node) => node.dataset.neighbour,
        );
        expect(names).toEqual(['st', 'des', 'desru', 'ck', 'bunnymo', 'qvink', 'nai', 'localizer', 'preset']);
        expect(container.querySelector('[data-neighbour="st"]')?.textContent).toContain('версия 1.19.0');
        expect(container.querySelector('[data-neighbour="des"]')?.textContent).toContain('не найден');
        expect(container.textContent).toContain('Всё, что нужно Maestro, на месте.');
        buttonNamed(container, 'Проверить заново')!.click();
        await flush();
        expect(s.caps.refreshes).toBe(1);
    });

    it('names the unsupported cases', () => {
        const context = s.stand.mock.context as unknown as Record<string, unknown>;
        context.groupId = 'group-1';
        context.mainApi = 'textgenerationwebui';
        s.caps.ok.delete('st.cm');
        s.caps.register('st.cm', () => false);
        const { container } = render('w1.stack');
        expect(container.textContent).toContain('Это групповой чат');
        expect(container.textContent).toContain('Основной API — Text Completion');
        expect(container.textContent).toContain('Connection Manager выключен');
        expect(container.querySelector('[data-neighbour="st"] details')?.textContent).toContain('st.cm');
    });
});

describe('step 2: macro engine', () => {
    it('is done at once when the new engine is on or the setting does not exist', () => {
        const on = render('w1.macros');
        expect(on.done).toHaveBeenCalled();
        expect(on.container.textContent).toContain('включён');
        s.caps.ok.delete('st.macros.newEngine');
        const missing = render('w1.macros');
        expect(missing.done).toHaveBeenCalled();
        expect(missing.container.textContent).toContain('нет переключателя');
    });

    it('turns the engine on only on click, like ST’s checkbox, journals and undoes it', async () => {
        s.caps.ok.delete('st.macros.newEngine');
        const power = s.stand.mock.context.powerUserSettings;
        power.experimental_macro_engine = false;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.id = 'experimental_macro_engine';
        const inputs: boolean[] = [];
        box.addEventListener('input', () => inputs.push(box.checked));
        document.body.appendChild(box);
        const { container, done } = render('w1.macros');
        expect(done).not.toHaveBeenCalled();
        expect(power.experimental_macro_engine).toBe(false);
        buttonNamed(container, 'Включить новый движок макросов')!.click();
        await flush();
        expect(power.experimental_macro_engine).toBe(true);
        expect(inputs).toEqual([true]);
        expect(s.stand.mock.saveSettingsCalls).toBe(1);
        expect(s.caps.refreshes).toBe(1);
        expect(done).toHaveBeenCalled();
        expect(container.textContent).toContain('Перезагрузи страницу');
        expect(s.journal.records[0]).toMatchObject({
            module: 'W1',
            kind: 'wizard.macroEngine',
            changes: [
                { target: 'wizard-power-user', ref: { key: 'experimental_macro_engine' }, before: false, after: true },
            ],
        });
        expect(await s.journal.undo(s.journal.records[0]!.id)).toBe(true);
        expect(power.experimental_macro_engine).toBe(false);
        expect(box.checked).toBe(false);
        const bad = s.journal.handlers.get('wizard-power-user')!;
        expect(await bad({ target: 'wizard-power-user', ref: {}, before: false, after: true })).toBe(false);
    });
});

describe('step 3: baseline', () => {
    it('steps aside without the Guardian', () => {
        const { container, done } = render('w1.baseline');
        expect(done).toHaveBeenCalled();
        expect(container.textContent).toContain('Страж (M4) выключен');
    });

    it('takes the baseline on click and is done after it', async () => {
        const guardian = fakeGuardian(false);
        s.modules.expose('guardian', guardian);
        const { container, done } = render('w1.baseline');
        expect(done).not.toHaveBeenCalled();
        expect(container.textContent).toContain('Эталона пока нет.');
        buttonNamed(container, 'Снять эталон')!.click();
        await flush();
        expect(guardian.taken).toEqual(['wizard']);
        expect(done).toHaveBeenCalled();
        expect(container.textContent).toContain('Эталон снят.');
        expect(buttonNamed(container, 'Снять заново')).toBeDefined();
        s.modules.expose('guardian', fakeGuardian(true));
        expect(render('w1.baseline').done).toHaveBeenCalled();
    });
});

describe('step 4: findings', () => {
    it('steps aside without the Doctor', () => {
        const { container, done } = render('w1.findings');
        expect(done).toHaveBeenCalled();
        expect(container.textContent).toContain('Доктор (M5) выключен');
    });

    it('runs the Doctor and summarises the findings', async () => {
        s.stand.books.set(
            'Архив',
            storedBook({
                key: ['Анна'],
                comment: 'Анна',
                content: '<BunnymoTags><Name:Анна></BunnymoTags>',
                position: 4,
                role: 2,
            }),
        );
        s.stand.worldInfo.selected_world_info = ['Архив'];
        s.regex.global.push({ id: 'g', scriptName: 'Mine', findRegex: '/a/', placement: [1] });
        extraStops.push(await s.start(doctorModule));
        const { container, done } = render('w1.findings');
        expect(container.textContent).toContain('Доктор проверяет');
        await flush(20);
        expect(done).toHaveBeenCalled();
        expect(container.textContent).toContain('Ошибок: 0 · предупреждений: 1 · заметок: 0');
        expect(container.textContent).toContain('Регексов: 1');
        expect(container.querySelector('.maestro-w1-top')?.textContent).toContain('с ролью assistant');
        buttonNamed(container, 'Открыть вкладку «Доктор»')!.click();
        expect(s.ui.opened).toEqual(['doctor']);
    });

    it('reports a failed scan and an empty result', async () => {
        const failing = {
            scan: async () => Promise.reject(new Error('boom')),
            findings: () => [],
            regexInventory: async () => [],
        };
        s.modules.expose('doctor', failing as DoctorApi);
        const failed = render('w1.findings');
        await flush();
        expect(failed.container.textContent).toContain('Проверка не удалась: boom');
        expect(failed.done).toHaveBeenCalled();
        const empty = { scan: async () => [], findings: () => [], regexInventory: async () => [] };
        s.modules.expose('doctor', empty as DoctorApi);
        const clean = render('w1.findings');
        await flush();
        expect(clean.container.textContent).toContain('Доктор ничего не нашёл.');
    });
});

describe('step 5: rules', () => {
    it('steps aside without the Rules module', () => {
        const { container, done } = render('w1.rules');
        expect(done).toHaveBeenCalled();
        expect(container.textContent).toContain('«Правила» (M22) выключен');
    });

    it('offers stage 1–2 rules with defaults, compares and applies on «Далее» with book caps', async () => {
        const rules = new FakeRules(RULES);
        s.modules.expose('rules', rules);
        s.modules.expose(
            'loreJournal',
            fakeLoreJournal({
                turns: 12,
                heaviestBooks: [
                    { world: 'Flora', activations: 12, avgChars: 134_000 },
                    { world: 'Tiny', activations: 12, avgChars: 2000 },
                ],
            }),
        );
        const { container, done, next } = render('w1.rules', true);
        await flush();
        expect(done).toHaveBeenCalled();
        const rows = [...container.querySelectorAll<HTMLElement>('.maestro-w1-rule')];
        expect(rows.map((row) => row.dataset.rule)).toEqual([
            'role.assistantToSystem',
            'tags.show',
            'ck.button',
            'book.cap',
        ]);
        const box = (id: string) =>
            container.querySelector<HTMLInputElement>(`[data-rule="${id}"] input[type="checkbox"]`)!;
        expect(['role.assistantToSystem', 'tags.show', 'ck.button', 'book.cap'].map((id) => box(id).checked)).toEqual([
            true,
            true,
            false,
            true,
        ]);
        expect(buttonNamed(container.querySelector('[data-rule="tags.show"]')!, 'Сравнить до/после')).toBeUndefined();

        buttonNamed(container.querySelector('[data-rule="role.assistantToSystem"]')!, 'Сравнить до/после')!.click();
        await flush();
        const compare = container.querySelector('[data-rule="role.assistantToSystem"] .maestro-w1-compare')!;
        expect(compare.textContent).toContain('Лор за ход: −4');
        expect(compare.textContent).toContain('Уходят из промпта (1): «Ballroom» (Flora)');

        const cap = container.querySelector<HTMLInputElement>('.maestro-w1-caps input')!;
        expect(cap.value).toBe('11500');
        expect(container.querySelector('.maestro-w1-caps')?.textContent).toContain('сейчас около 33');
        expect(container.querySelectorAll('.maestro-w1-caps input')).toHaveLength(1);

        box('role.assistantToSystem').click();
        box('ck.button').click();
        cap.value = '9000';
        cap.dispatchEvent(new Event('change'));
        next!.click();
        await flush();
        expect(rules.switched).toEqual([
            ['tags.show', true],
            ['ck.button', true],
            ['book.cap', true],
        ]);
        expect(settings().bookCaps).toEqual({ Flora: 9000 });
        const record = s.journal.records.at(-1)!;
        expect(record).toMatchObject({
            module: 'W1',
            kind: 'wizard.rules',
            summary: 'Мастер первого запуска: правила (4)',
        });
        // The listener is gone after the first click.
        next!.click();
        await flush();
        expect(rules.switched).toHaveLength(3);
        expect(await s.journal.undo(record.id)).toBe(true);
        expect(rules.isEnabled('tags.show')).toBe(false);
        expect(settings().bookCaps).toEqual({});
    });

    it('hands caps to the rules module when it takes options, and shows a failed comparison', async () => {
        const rules = new FakeRules(RULES);
        rules.setOptions = vi.fn(async () => {});
        rules.options.mockReturnValue({ caps: { Old: 5000, Zero: 0 } });
        rules.impact = new Error('no lore journal');
        s.modules.expose('rules', rules);
        s.settings.core().firstRunDone = true;
        await rules.setEnabled('ck.button', true);
        const { container, next } = render('w1.rules', true);
        await flush();
        // Not the first run: toggles show the current state.
        expect(container.querySelector<HTMLInputElement>('[data-rule="ck.button"] input')!.checked).toBe(true);
        expect(container.querySelector<HTMLInputElement>('[data-rule="tags.show"] input')!.checked).toBe(false);
        buttonNamed(container.querySelector('[data-rule="book.cap"]')!, 'Сравнить до/после')!.click();
        await flush();
        expect(container.textContent).toContain('Сравнить не удалось: no lore journal');
        expect(container.querySelector<HTMLInputElement>('.maestro-w1-caps input')!.value).toBe('5000');
        next!.click();
        await flush();
        expect(rules.setOptions).not.toHaveBeenCalled();
        const caps = container.querySelector<HTMLInputElement>('.maestro-w1-caps input')!;
        expect(caps).toBeTruthy();
    });

    it('applies through its own button outside the wizard shell and suggests caps from the Doctor', async () => {
        const rules = new FakeRules(RULES);
        rules.setOptions = vi.fn(async () => {});
        s.modules.expose('rules', rules);
        s.stand.books.set(
            'Flora',
            storedBook(
                ...Array.from({ length: 10 }, (_, i) => ({
                    key: [`k${i}`],
                    comment: `E${i}`,
                    content: 'x'.repeat(5000),
                })),
            ),
        );
        s.stand.worldInfo.selected_world_info = ['Flora'];
        extraStops.push(await s.start(doctorModule));
        const { container } = render('w1.rules');
        await flush(20);
        expect(container.querySelector('.maestro-w1-caps')?.textContent).toContain('всего около 12');
        buttonNamed(container, 'Применить')!.click();
        await flush();
        expect(rules.setOptions).toHaveBeenCalledWith('book.cap', { caps: { Flora: 4500 } });
        expect(s.ui.notices.at(-1)?.text).toBe('Правила применены.');
    });

    it('says when no book needs a cap and when no rule is registered', async () => {
        s.modules.expose('rules', new FakeRules([]));
        const { container } = render('w1.rules');
        await flush();
        expect(container.textContent).toContain('Правила этапа 1 пока не зарегистрированы.');
        expect(container.textContent).toContain('Ни одна книга не настолько тяжела');
    });

    it('reports a failed apply as a notice', async () => {
        const rules = new FakeRules(RULES);
        rules.setEnabled = async () => {
            throw new Error('nope');
        };
        s.modules.expose('rules', rules);
        const { next } = render('w1.rules', true);
        await flush();
        next!.click();
        await flush();
        expect(s.ui.notices.at(-1)).toMatchObject({
            text: 'Правила не применились: nope',
            options: { level: 'error' },
        });
    });
});

describe('step 6: background tasks', () => {
    it('saves the daily cap and the default profile', () => {
        s.settings.core().profiles.default = 'gone';
        const { container, done } = render('w1.background');
        expect(done).toHaveBeenCalled();
        const cap = container.querySelector<HTMLInputElement>('input[type="number"]')!;
        cap.value = '1.5';
        cap.dispatchEvent(new Event('change'));
        expect(s.settings.core().backgroundDailyCapUsd).toBe(1.5);
        const profile = container.querySelector<HTMLSelectElement>('select')!;
        expect([...profile.options].map((option) => option.textContent)).toEqual([
            'Не выбран',
            'Profile 1',
            'Профиль не найден (gone)',
        ]);
        profile.value = 'p1';
        profile.dispatchEvent(new Event('change'));
        expect(s.settings.core().profiles.default).toBe('p1');
        profile.value = '';
        profile.dispatchEvent(new Event('change'));
        expect(s.settings.core().profiles.default).toBeUndefined();
        expect(container.textContent).toContain('Основная модель чата остаётся как есть.');
    });

    it('explains that background tasks need the Connection Manager', () => {
        s.caps.ok.delete('st.cm');
        const { container } = render('w1.background');
        expect(container.querySelector('select')).toBeNull();
        expect(container.textContent).toContain('Connection Manager выключен');
    });
});

describe('step 7: old chats', () => {
    it('stores the policy and shows the cost of parsing this chat', () => {
        s.stand.mock.chat = [
            message('А'.repeat(3500)),
            message('Б'.repeat(3500), { is_user: true }),
            message('sys', { is_system: true }),
        ];
        const { container, done } = render('w1.oldChats');
        expect(done).toHaveBeenCalled();
        expect(container.querySelector('.maestro-segment.maestro-on')?.textContent).toBe('С текущего момента');
        expect(container.textContent).toContain('В этом чате сообщений: 2, это около 2');
        container.querySelector<HTMLButtonElement>('.maestro-segment[data-value="bootstrap"]')!.click();
        expect(settings().oldChatsPolicy).toBe('bootstrap');
        expect(container.querySelector('.maestro-hint')?.textContent).toContain('Один фоновый проход');
    });

    it('asks to open a chat when there is none', () => {
        s.stand.mock.chatId = undefined;
        const { container } = render('w1.oldChats');
        expect(container.textContent).toContain('Открой чат');
    });
});

describe('inside the real wizard shell', () => {
    it('applies the rules when «Далее» leaves the rules step', async () => {
        const rules = new FakeRules(RULES);
        s.modules.expose('rules', rules);
        s.stand.setCtx('Popup', FakePopup);
        s.stand.setCtx('POPUP_TYPE', POPUP_TYPE);
        const wizard = new Wizard({ host: s.app.host, i18n: s.i18n, log: silentLog, settings: s.settings });
        for (const item of s.ui.steps) wizard.add(item);
        wizard.open();
        const next = () => document.querySelector<HTMLButtonElement>('.maestro-wizard-next')!;
        while (wizard.currentStep() !== 'w1.rules') next().click();
        await flush();
        expect(next().textContent).toContain('Далее');
        next().click();
        await flush();
        expect(wizard.currentStep()).toBe('w1.background');
        expect(rules.switched.map(([id]) => id)).toEqual(['role.assistantToSystem', 'tags.show', 'book.cap']);
        wizard.dispose();
    });

    it('onNext reports false outside the shell and ignores a step that left the screen', async () => {
        const loose = document.createElement('div');
        expect(
            onNext(
                loose,
                () => {},
                () => {},
            ),
        ).toBe(false);
        const root = document.createElement('div');
        root.className = 'maestro-wizard';
        const container = document.createElement('div');
        const button = document.createElement('button');
        button.className = 'maestro-wizard-next';
        root.append(container, button);
        document.body.appendChild(root);
        const apply = vi.fn();
        const errors: unknown[] = [];
        expect(onNext(container, apply, (error) => errors.push(error))).toBe(true);
        container.remove();
        button.click();
        await flush();
        expect(apply).not.toHaveBeenCalled();
        root.prepend(container);
        onNext(
            container,
            () => {
                throw new Error('bad');
            },
            (error) => errors.push(error),
        );
        button.click();
        await flush();
        expect(errors).toHaveLength(1);
    });
});
