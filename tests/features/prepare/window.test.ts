// @vitest-environment happy-dom
// The window «Подготовка к игре» over a fake engine: what will be read and the price before the run, the run with its
// progress and «Остановить», the review (sections with counts, cards with «уже есть» and the canon's other version,
// choices per item and per section, scopes, edits under «Подробнее»), apply with the confirmation for the character,
// the result with undo and links to the right windows, «Готово к игре» with its buttons; the step survives a redraw.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SelectionRow } from '../../../src/features/prepare/api';
import { renderPrepare } from '../../../src/features/prepare/window';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { buttonOf, card, fakeStand, hasButton, item, samplePlan, tick, windowContext } from './ui-helpers';
import type { FakeStand } from './ui-helpers';

let stand: FakeStand;
let container: HTMLElement;
let close: Unsubscribe | null = null;

beforeEach(() => {
    stand = fakeStand();
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(() => {
    close?.();
    close = null;
    container.remove();
});

async function open(): Promise<ReturnType<typeof windowContext>> {
    const ctx = windowContext();
    close = renderPrepare(container, stand.ui, ctx);
    await tick();
    return ctx;
}

function text(): string {
    return container.textContent ?? '';
}

async function toReview(): Promise<void> {
    stand.engine.planValue = samplePlan();
    stand.engine.current = { stage: 'ready', jobKey: 'prepare:chat-1' };
    await open();
}

describe('prepare window: before the run', () => {
    it('shows what will be read, what not, the price, and starts the run', async () => {
        await open();
        expect(text()).toContain('1. Что читать');
        expect(text()).toContain('Что прочитает Maestro');
        expect(text()).toContain('Описание карточки');
        expect(text()).toContain('Velmar Reaches · Silver Harbor');
        expect(text()).toContain('Не войдёт в бюджет: Velmar Reaches · Old Songs');
        expect(container.querySelector('.maestro-m37w-cost')?.textContent).toMatch(/^≈ .*0[.,]02.*, 3 части$/);
        expect(text()).toContain('дневной лимит фоновых трат его не останавливает');
        expect(stand.engine.estimates).toEqual([{}]);
        expect(stand.engine.watching).toBe(1);

        buttonOf(container, 'Начать').click();
        await tick();
        expect(stand.engine.starts).toEqual([{}]);
        expect(text()).toContain('2. Разбор');
        expect(text()).toContain('Читаю карточку и книги…');
        stand.engine.progress(1, 3);
        await tick();
        expect(text()).toContain('Читаю часть 2 из 3…');
        expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('1');
        stand.engine.progress(3, 3);
        await tick();
        expect(text()).toContain('Собираю план…');

        stand.engine.finish(samplePlan());
        await tick();
        expect(text()).toContain('3. Просмотр');
        expect(text()).toContain('Персонажи (2)');
    });

    it('stops the run with «Остановить»', async () => {
        await open();
        buttonOf(container, 'Начать').click();
        await tick();
        buttonOf(container, 'Остановить').click();
        await tick();
        expect(stand.engine.cancelled).toBe(1);
        expect(text()).toContain('Остановлюсь после текущей части…');
    });

    it('offers the saved preparation: apply it, or read only what changed (an option)', async () => {
        stand.engine.saved = {
            avatar: 'silver-harbor.png',
            cardName: 'Хроники',
            savedAt: Date.now(),
            items: samplePlan().items.slice(0, 3),
            book: 'Maestro · подготовка · Хроники',
            changed: ['Сценарий'],
        };
        await open();
        expect(text()).toContain('Сохранённая подготовка персонажа');
        expect(text()).toContain('пунктов: 3');
        expect(text()).toContain('С тех пор изменилось: Сценарий');
        expect(stand.engine.estimates).toEqual([{ reuse: true }]);
        const reuse = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
            box.closest('label')?.textContent?.includes('только изменившееся'),
        )!;
        expect(reuse.checked).toBe(true);
        reuse.checked = false;
        reuse.dispatchEvent(new Event('change'));
        await tick();
        expect(stand.engine.estimates).toEqual([{ reuse: true }, {}]);
        buttonOf(container, 'Начать').click();
        await tick();
        expect(stand.engine.starts).toEqual([{}]);
    });

    it('applies the saved preparation from the first step and shows the result', async () => {
        stand.engine.saved = {
            avatar: 'a',
            cardName: 'Хроники',
            savedAt: 1,
            items: samplePlan().items.slice(0, 2),
            book: null,
            changed: [],
        };
        await open();
        expect(text()).toContain('ничего не изменилось');
        buttonOf(container, 'Применить сохранённое').click();
        await tick();
        expect(stand.engine.appliedSaved).toBe(1);
        expect(text()).toContain('4. Итог');
        expect(text()).toContain('Элизабет: в канон');
    });

    it('says why a started chat is not prepared', async () => {
        stand.engine.eligible = { ok: false, reason: 'started' };
        await open();
        expect(text()).toContain('Чат уже начат');
        expect(hasButton(container, 'Начать')).toBe(false);
    });
});

describe('prepare window: the review', () => {
    it('lists the sections with counts and the cards with their marks', async () => {
        await toReview();
        const nav = container.querySelector('.maestro-m37w-nav')!.textContent;
        expect(nav).toContain('Мир (1)');
        expect(nav).toContain('Места (2)');
        expect(nav).toContain('Персонажи (2)');
        expect(nav).toContain('Механики (1)');
        expect(nav).toContain('Секреты (1)');
        const elizabeth = card(container, 'character:elizabeth');
        expect(elizabeth.textContent).toContain('Хозяйка таверны, рыжая и острая на язык');
        expect(elizabeth.textContent).toContain('Формы имени: Лиза');
        expect(elizabeth.textContent).toContain('в первой сцене');
        expect(elizabeth.textContent).toContain('В каноне («Elizabeth») сказано иначе — внешность:');
        expect(elizabeth.textContent).toContain('«Black hair»');
        expect(elizabeth.classList.contains('maestro-m37w-conflict')).toBe(true);
        const fort = card(container, 'place:old fort');
        expect(fort.textContent).toContain('место уже есть');
        expect(fort.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
        expect(card(container, 'character:kai').querySelector<HTMLInputElement>('input')!.checked).toBe(false);
        expect(card(container, 'mechanic:reputation').textContent).toContain('Показатели: Репутация');
        expect(card(container, 'secret:abc').textContent).toContain('Скрыто от: Кай');
        expect(card(container, 'place:rusty anchor').textContent).toContain('Где: Серебряная Гавань');
        expect(text()).toContain('Выбрано: 5 из 7');
    });

    it('applies the chosen items with their scopes and edits; the character scope is confirmed once', async () => {
        await toReview();
        // Off: the world. Per section: places for the character. Edit Elizabeth's name and appearance.
        const world = card(container, 'world').querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        world.checked = false;
        world.dispatchEvent(new Event('change'));
        const placeSection = container.querySelector<HTMLElement>('.maestro-m37w-section[data-kind="place"]')!;
        const sectionScope = placeSection.querySelector<HTMLSelectElement>('.maestro-m37w-section-head select')!;
        sectionScope.value = 'character';
        sectionScope.dispatchEvent(new Event('change'));
        const elizabeth = card(container, 'character:elizabeth');
        const details = elizabeth.querySelector('details')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        const fields = [...elizabeth.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('.maestro-m37w-field')];
        const name = fields.find((field) => field.textContent?.includes('Имя, как в истории'))!.querySelector('input')!;
        name.value = 'Элизабет Морн';
        name.dispatchEvent(new Event('input'));
        const look = fields.find((field) => field.textContent?.includes('Внешность'))!.querySelector('textarea')!;
        look.value = 'Black hair, green eyes';
        look.dispatchEvent(new Event('input'));
        expect(elizabeth.querySelector('.maestro-m37w-title')?.textContent).toBe('Элизабет Морн');
        expect(elizabeth.textContent).toContain('изменено');
        expect(text()).toContain('Выбрано: 4 из 7');

        // Closing and opening the window again keeps all of it (the chat's draft).
        close?.();
        await open();
        expect(text()).toContain('Выбрано: 4 из 7');
        const again = card(container, 'character:elizabeth');
        expect(again.querySelector('.maestro-m37w-title')?.textContent).toBe('Элизабет Морн');
        expect(again.querySelector('details')!.open).toBe(true);
        expect(again.querySelector('textarea')!.value).toBe('Black hair, green eyes');

        buttonOf(container, 'Применить выбранное').click();
        await tick();
        expect(stand.env.ui.confirms).toHaveLength(1);
        expect(stand.env.ui.confirms[0]!.body).toContain('Пунктов для персонажа: 1');
        const call = stand.engine.applies[0]!;
        expect(call.options).toMatchObject({ confirmed: true });
        const rows = call.selection as SelectionRow[];
        expect(rows.map((row) => row.id)).toEqual([
            'character:elizabeth',
            'place:rusty anchor',
            'mechanic:reputation',
            'secret:abc',
        ]);
        expect(rows[0]).toEqual({
            id: 'character:elizabeth',
            scope: 'chat',
            data: { name: 'Элизабет Морн', appearance: 'Black hair, green eyes' },
        });
        expect(rows[1]).toEqual({ id: 'place:rusty anchor', scope: 'character' });
        expect(text()).toContain('4. Итог');
    });

    it('does nothing when the character scope is declined', async () => {
        await toReview();
        const scope = card(container, 'secret:abc').querySelector<HTMLSelectElement>('.maestro-m37w-scope')!;
        scope.value = 'character';
        scope.dispatchEvent(new Event('change'));
        stand.env.ui.confirmAnswer = false;
        buttonOf(container, 'Применить выбранное').click();
        await tick();
        expect(stand.engine.applies).toEqual([]);
        expect(text()).toContain('3. Просмотр');
    });

    it('selects all or nothing per section (never the player himself)', async () => {
        await toReview();
        const section = container.querySelector<HTMLElement>('.maestro-m37w-section[data-kind="character"]')!;
        const all = section.querySelector<HTMLInputElement>('.maestro-m37w-section-head input')!;
        expect(all.checked).toBe(true);
        all.checked = false;
        all.dispatchEvent(new Event('change'));
        expect(card(container, 'character:elizabeth').classList.contains('maestro-m37w-off')).toBe(true);
        expect(text()).toContain('Выбрано: 4 из 7');
        all.checked = true;
        all.dispatchEvent(new Event('change'));
        expect(card(container, 'character:kai').querySelector<HTMLInputElement>('input')!.checked).toBe(false);
        expect(text()).toContain('Выбрано: 5 из 7');
        const places = container.querySelector<HTMLElement>('.maestro-m37w-section[data-kind="place"]')!;
        const placesAll = places.querySelector<HTMLInputElement>('.maestro-m37w-section-head input')!;
        expect(placesAll.indeterminate).toBe(true);
    });

    it('drops the edits with «Убрать мои правки»', async () => {
        await toReview();
        const world = card(container, 'world');
        const details = world.querySelector('details')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        const input = world.querySelector<HTMLInputElement>('.maestro-m37w-field input')!;
        input.value = 'Гавань';
        input.dispatchEvent(new Event('input'));
        expect(world.querySelector('.maestro-m37w-title')?.textContent).toBe('Гавань');
        buttonOf(world, 'Убрать мои правки').click();
        expect(world.querySelector('.maestro-m37w-title')?.textContent).toBe('Серебряная Гавань');
        expect(world.querySelector<HTMLInputElement>('.maestro-m37w-field input')!.value).toBe('Серебряная Гавань');
    });

    it('forgets the plan after a confirmation and goes back to the first step', async () => {
        await toReview();
        buttonOf(container, 'Забыть план').click();
        await tick();
        expect(stand.engine.discarded).toBe(1);
        expect(text()).toContain('1. Что читать');
    });

    it('«Разобрать заново» goes back to the estimate; «Вернуться к плану» returns', async () => {
        await toReview();
        buttonOf(container, 'Разобрать заново').click();
        await tick();
        expect(text()).toContain('1. Что читать');
        buttonOf(container, 'Вернуться к плану').click();
        await tick();
        expect(text()).toContain('3. Просмотр');
    });
});

describe('prepare window: the starting scenes', () => {
    function scenesPlan() {
        const plan = samplePlan();
        plan.openings = ['Дождь барабанит по ставням таверны…', 'Рассвет над Серебряной Гаванью…', ''];
        plan.items.push(
            item(
                'scene',
                {
                    greeting: 0,
                    place: 'Ржавый якорь',
                    date: 'День 1',
                    time: 'вечер',
                    present: ['Элизабет'],
                    outfits: [{ name: 'Элизабет', wearing: 'a dark green cloak' }],
                    firstScene: 'dialogue',
                },
                { id: 'scene:0', russian: 'Элизабет ждёт героя в таверне.' },
            ),
            item(
                'scene',
                {
                    greeting: 1,
                    place: 'Серебряная Гавань',
                    time: 'рассвет',
                    present: ['Вера'],
                    firstScene: 'exploration',
                },
                { id: 'scene:1', russian: 'Вера показывает пустой трюм.' },
            ),
            item(
                'scene',
                { greeting: 2, place: 'Архив гильдии картографов', time: 'ночь', present: ['Мартин'] },
                { id: 'scene:2', russian: 'Мартин нашёл лишнюю запись.' },
            ),
        );
        return plan;
    }

    it('shows «Стартовые сцены (3)» with a card per greeting and marks the one in the chat now', async () => {
        stand.engine.scenesInfo = { shown: 1, prepared: [], active: null, locked: false };
        stand.engine.planValue = scenesPlan();
        stand.engine.current = { stage: 'ready', jobKey: 'prepare:chat-1' };
        await open();
        const nav = container.querySelector('.maestro-m37w-nav')!.textContent;
        expect(nav).toContain('Стартовые сцены (3)');
        const section = container.querySelector<HTMLElement>('.maestro-m37w-section[data-kind="scene"]')!;
        expect(section.textContent).toContain('Действует та, что сейчас в чате');
        const titles = [...section.querySelectorAll('.maestro-m37w-title')].map((node) => node.textContent);
        expect(titles).toEqual([
            'Сцена 1 · «Дождь барабанит по ставням таверны…»',
            'Сцена 2 · «Рассвет над Серебряной Гаванью…»',
            'Сцена 3 (Архив гильдии картографов)',
        ]);
        const shown = card(container, 'scene:1');
        expect(shown.textContent).toContain('сейчас в чате');
        expect(shown.classList.contains('maestro-m37w-shown')).toBe(true);
        expect(card(container, 'scene:0').textContent).not.toContain('сейчас в чате');
        const first = card(container, 'scene:0');
        expect(first.textContent).toContain('Элизабет ждёт героя в таверне.');
        expect(first.textContent).toContain('Место: Ржавый якорь');
        expect(first.textContent).toContain('Начало: День 1, вечер');
        expect(first.textContent).toContain('В сцене: Элизабет');
        expect(first.textContent).toContain('Наряды: Элизабет');
        expect(first.textContent).toContain('Первая сцена: разговор');
        expect(first.textContent).not.toContain('dark green cloak');
        // The English outfits and the type are under «Подробнее».
        const details = first.querySelector('details')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        expect(details.textContent).toContain('Наряды в начале: Элизабет: a dark green cloak');
        const type = details.querySelector<HTMLSelectElement>('select')!;
        expect(type.value).toBe('dialogue');
        type.value = 'combat';
        type.dispatchEvent(new Event('change'));
        // Every scene is chosen; the swipe moves the mark.
        expect(text()).toContain('Выбрано: 8 из 10');
        stand.engine.scenesInfo = { shown: 2, prepared: [], active: null, locked: false };
        stand.engine.emit();
        await tick();
        expect(card(container, 'scene:2').textContent).toContain('сейчас в чате');
        expect(card(container, 'scene:1').textContent).not.toContain('сейчас в чате');
        buttonOf(container, 'Применить выбранное').click();
        await tick();
        const rows = stand.engine.applies[0]!.selection as SelectionRow[];
        expect(rows.filter((row) => row.id.startsWith('scene:'))).toEqual([
            { id: 'scene:0', scope: 'chat', data: { firstScene: 'combat' } },
            { id: 'scene:1', scope: 'chat' },
            { id: 'scene:2', scope: 'chat' },
        ]);
    });

    it('«Готово к игре» says how many starts are prepared and which one is active', async () => {
        stand.engine.statusValue = {
            ready: true,
            missing: [],
            lines: [],
            scenes: {
                prepared: 3,
                active: 1,
                line: 'Подготовлено стартовых сцен: 3. Сейчас в чате: Сцена 2 (Серебряная Гавань).',
            },
        };
        stand.engine.planValue = scenesPlan();
        stand.engine.current = { stage: 'applied', jobKey: 'prepare:chat-1', appliedAt: Date.now() };
        await open();
        expect(text()).toContain('4. Итог');
        const line = container.querySelector<HTMLElement>('.maestro-m37w-line[data-scenes="3"]')!;
        expect(line.textContent).toBe('Подготовлено стартовых сцен: 3. Сейчас в чате: Сцена 2 (Серебряная Гавань).');
        expect(text()).toContain('Всё важное на месте.');
    });
});

describe('prepare window: «Персонажи в DES» (1.18)', () => {
    function desSwitch(): HTMLInputElement | undefined {
        return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
            box.closest('label')?.textContent?.startsWith('Персонажи в DES'),
        );
    }

    it('offers the switch when DES is there and the plan has starting scenes, and passes the choice', async () => {
        const plan = samplePlan();
        plan.items.push(
            item('scene', { greeting: 0, place: 'Ржавый якорь', present: ['Элизабет'] }, { id: 'scene:0' }),
        );
        stand.engine.planValue = plan;
        stand.engine.current = { stage: 'ready', jobKey: 'prepare:chat-1' };
        await open();
        expect(desSwitch()).toBeUndefined();
        close?.();
        container.replaceChildren();
        stand.engine.desOffered = true;
        await open();
        const box = desSwitch()!;
        expect(box.checked).toBe(true);
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        stand.engine.applyAnswer = () => ({
            done: [
                {
                    itemId: 'des',
                    kind: 'des',
                    text: 'Персонажи в DES: Сцена 1 (Ржавый якорь) — Элизабет',
                    journalId: 'j9',
                },
            ],
            skipped: [],
            failed: [],
            proposals: [],
        });
        buttonOf(container, 'Применить выбранное').click();
        await tick();
        expect(stand.engine.applies[0]?.options).toMatchObject({ desSeed: false, confirmed: true });
        // The DES line: undo, no window to open.
        const line = container.querySelector<HTMLElement>('.maestro-m37w-line[data-item="des"]')!;
        expect(line.textContent).toContain('Персонажи в DES: Сцена 1 (Ржавый якорь) — Элизабет');
        expect(hasButton(line, 'Отменить')).toBe(true);
        expect(line.querySelectorAll('button')).toHaveLength(1);
    });
});

describe('prepare window: the result and «Готово к игре»', () => {
    it('lists what was done with undo and links, then what is still missing with buttons', async () => {
        stand.engine.statusValue = {
            ready: false,
            missing: [
                { kind: 'passport', name: 'Элизабет' },
                { kind: 'portrait', name: 'Элизабет' },
                { kind: 'place', name: 'Ржавый якорь' },
                { kind: 'background', name: 'Старый форт' },
            ],
            lines: [
                'Нет паспорта: Элизабет',
                'Нет портрета: Элизабет',
                'Место «Ржавый якорь» ещё не создано',
                'Нет фона для «Старый форт»',
            ],
        };
        stand.engine.applyAnswer = () => ({
            done: [
                {
                    itemId: 'character:elizabeth',
                    kind: 'character',
                    text: 'Элизабет: в канон, паспорт',
                    journalId: 'j1',
                },
                { itemId: 'place:rusty anchor', kind: 'place', text: 'Ржавый якорь: место, в канон', journalId: 'j2' },
            ],
            failed: [{ itemId: 'secret:abc', kind: 'secret', text: 'Секрет: не удалось (модуль выключен)' }],
            skipped: [{ itemId: 'mechanic:reputation', kind: 'mechanic', text: 'Репутация: уже есть' }],
            proposals: ['Для «Ржавый якорь» есть подходящий фон из библиотеки: tavern-rain.jpg'],
        });
        await toReview();
        buttonOf(container, 'Применить выбранное').click();
        await tick();
        expect(text()).toContain('Что сделано');
        expect(text()).toContain('Элизабет: в канон, паспорт');
        expect(text()).toContain('Секрет: не удалось (модуль выключен)');
        expect(text()).toContain('Пропущено (1)');
        expect(text()).toContain('tavern-rain.jpg');

        // Links: the dossier of the characters window, the places of the world window, backgrounds through the pult.
        const elizabeth = container.querySelector<HTMLElement>('.maestro-m37w-line[data-item="character:elizabeth"]')!;
        buttonOf(elizabeth, 'Персонажи').click();
        expect(stand.shell.opened).toEqual([{ id: 'characters', options: { tab: 'dossier' } }]);
        buttonOf(container, 'Фоны').click();
        expect(stand.shell.pult).toEqual(['backgrounds']);

        // Undo one part.
        buttonOf(elizabeth, 'Отменить').click();
        await tick();
        expect(stand.engine.undos).toEqual(['character:elizabeth']);
        const undone = container.querySelector<HTMLElement>('.maestro-m37w-line[data-item="character:elizabeth"]')!;
        expect(undone.classList.contains('maestro-m37w-undone')).toBe(true);
        expect(undone.textContent).toContain('отменено');

        // «Готово к игре».
        expect(text()).toContain('Готово к игре');
        expect(text()).toContain('Нет паспорта: Элизабет');
        const passport = container.querySelector<HTMLElement>('.maestro-m37w-line[data-missing="passport"]')!;
        buttonOf(passport, 'Сделать паспорт').click();
        await tick();
        expect(stand.engine.applies[1]).toEqual({
            selection: [{ id: 'character:elizabeth', scope: 'chat' }],
            options: { passports: true, confirmed: true },
        });
        const place = container.querySelector<HTMLElement>('.maestro-m37w-line[data-missing="place"]')!;
        buttonOf(place, 'Создать место').click();
        await tick();
        expect(stand.engine.applies[2]?.selection).toEqual([{ id: 'place:rusty anchor', scope: 'chat' }]);
        buttonOf(container.querySelector<HTMLElement>('[data-missing="portrait"]')!, 'Открыть досье').click();
        buttonOf(container.querySelector<HTMLElement>('[data-missing="background"]')!, 'Подобрать фон').click();
        expect(stand.shell.opened.at(-1)).toEqual({ id: 'characters', options: { tab: 'dossier' } });
        expect(stand.shell.pult.at(-1)).toBe('backgrounds');

        // Back to the plan: what was applied exists now and starts off.
        buttonOf(container, 'К плану').click();
        await tick();
        expect(text()).toContain('3. Просмотр');
        expect(card(container, 'place:rusty anchor').querySelector<HTMLInputElement>('input')!.checked).toBe(false);
    });

    it('after a reload shows when it was applied and that everything is ready', async () => {
        stand.engine.planValue = samplePlan();
        stand.engine.current = { stage: 'applied', jobKey: 'prepare:chat-1', appliedAt: Date.now() };
        await open();
        expect(text()).toContain('4. Итог');
        expect(text()).toContain('Подготовка применена');
        expect(text()).toContain('Всё важное на месте.');
    });

    it('titles the window with the card and stops watching the job when closed', async () => {
        stand.engine.planValue = samplePlan();
        stand.engine.current = { stage: 'ready', jobKey: 'prepare:chat-1' };
        const ctx = await open();
        expect(ctx.titles).toContain('Подготовка: Хроники Серебряной Гавани');
        expect(stand.engine.watching).toBe(1);
        close?.();
        close = null;
        expect(stand.engine.watching).toBe(0);
        expect(container.children).toHaveLength(0);
    });
});
