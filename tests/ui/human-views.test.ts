// @vitest-environment happy-dom
// Plan-2 §3 «Понятные уведомления» in the core views: Inbox cards and journal records read in words (module title,
// the kind's label, described fields as «было → стало»), everything technical (kind id, target, ref locators, raw
// JSON keys) is under «Подробнее», collapsed unless «Показывать технические подробности» is on; Settings name the
// autonomy kinds and hold the notification level.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLabels, formatEnum } from '../../src/core/labels';
import type { InboxCard, JournalRecord } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { resetRegistries } from '../../src/ui/views/registries';
import { buildStDom, frontBody, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes, fakeAutonomy, FakeModules, fakeModule, inboxCard } from '../helpers/ui-fakes';
import type { CoreFakes } from '../helpers/ui-fakes';

let env: UiTestEnv;
let ui: UiImpl;
let fakes: CoreFakes;

const body = () => frontBody()!;

const STRINGS = {
    en: {
        'test.living': 'Living canon',
        'kind.living.fact': 'New facts about the world',
        'target.living-fact': 'Fact about the world',
        'test.field.name': 'Name',
        'test.field.type': 'What it is',
        'test.type.tradition': 'tradition',
    },
    ru: {
        'test.living': 'Живой канон',
        'kind.living.fact': 'Новые факты о мире',
        'target.living-fact': 'Факт о мире',
        'test.field.name': 'Название',
        'test.field.type': 'Что это',
        'test.type.tradition': 'традиция',
    },
};

function labels() {
    const registry = createLabels();
    registry.register([
        {
            target: 'living-fact',
            fields: {
                name: { labelKey: 'test.field.name' },
                type: { labelKey: 'test.field.type', format: formatEnum('test.type.') },
                keys: { labelKey: 'test.field.name', hidden: true },
            },
        },
    ]);
    return registry;
}

const CHANGE = {
    target: 'living-fact',
    ref: { id: 'lf-123', book: 'Chat canon of Anna' },
    before: null,
    after: { name: 'Праздник урожая', type: 'tradition', keys: ['урожай', 'harvest'], quote: 'В деревне праздник.' },
};

function card(overrides: Partial<InboxCard> = {}): InboxCard {
    return inboxCard('1', {
        module: 'M26',
        kind: 'living.fact',
        title: 'Новый факт о мире: Праздник урожая',
        description: 'В деревне каждую осень празднуют урожай.',
        details: 'Ключи: урожай, harvest',
        changes: [CHANGE],
        payload: { evidence: 'В деревне праздник.' },
        ...overrides,
    });
}

function start(overrides: Partial<CoreFakes> = {}): void {
    fakes = coreFakes(env, {
        modules: new FakeModules([fakeModule('livingCanon', { id: 'M26', titleKey: 'test.living' })]),
        labels: labels(),
        ...overrides,
    });
    ui.registerCoreViews(fakes);
}

beforeEach(() => {
    resetRegistries();
    buildStDom();
    env = installUiEnv('ru');
    env.settings.core().firstRunDone = true;
    env.i18n.register(STRINGS);
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
});

afterEach(() => {
    ui.dispose();
    vi.useRealTimers();
});

/** The card's text outside its «Подробнее» block. */
function mainText(node: HTMLElement): string {
    const clone = node.cloneNode(true) as HTMLElement;
    for (const details of clone.querySelectorAll('details.maestro-details')) details.remove();
    return clone.textContent ?? '';
}

describe('Inbox card in words', () => {
    it('shows module · kind label · time, the plain text and «было → стало» by human field names', () => {
        start();
        fakes.inbox.set([card()]);
        ui.openPult('inbox');
        const node = body().querySelector<HTMLElement>('.maestro-inbox-card')!;
        expect(node.querySelector('.maestro-card-subtitle, .maestro-muted')?.textContent).toMatch(
            /^Живой канон · Новые факты о мире · /,
        );
        const main = mainText(node);
        expect(main).toContain('В деревне каждую осень празднуют урожай.');
        expect(main).toContain('Факт о мире');
        expect(main).toContain('НазваниеПраздник урожая');
        expect(main).toContain('Что этотрадиция');
        for (const raw of ['living.fact', 'living-fact', 'lf-123', 'book', 'keys', 'harvest', '"name"', 'type']) {
            expect(main, raw).not.toContain(raw);
        }
        const details = node.querySelector<HTMLDetailsElement>('details.maestro-details')!;
        expect(details.open).toBe(false);
        expect(details.querySelector('summary')?.textContent).toBe('Подробнее');
        for (const raw of [
            'living.fact',
            'living-fact',
            'id: lf-123',
            'Chat canon of Anna',
            'Ключи: урожай, harvest',
        ]) {
            expect(details.textContent, raw).toContain(raw);
        }
    });

    it('keeps an undescribed change and an unnamed kind out of the main text', () => {
        start();
        fakes.inbox.set([
            card({
                kind: 'wardrobe.outfit',
                changes: [{ target: 'wardrobe.passport', ref: { passportId: 'p-1' }, before: 'a', after: 'b' }],
            }),
        ]);
        ui.openPult('inbox');
        const node = body().querySelector<HTMLElement>('.maestro-inbox-card')!;
        expect(mainText(node)).not.toContain('wardrobe');
        expect(node.querySelector('details.maestro-details')?.textContent).toContain('wardrobe.passport');
    });

    it('opens «Подробнее» right away when the user wants technical details', () => {
        env.settings.core().showTechnical = true;
        start();
        fakes.inbox.set([card()]);
        ui.openPult('inbox');
        expect(body().querySelector<HTMLDetailsElement>('details.maestro-details')?.open).toBe(true);
    });
});

describe('Journal in words', () => {
    const record: JournalRecord = {
        id: 'r1',
        module: 'M26',
        kind: 'living.fact',
        summary: 'Новый факт о мире: Праздник урожая',
        changes: [CHANGE],
        at: Date.now(),
        chatId: 'chat-1',
    };

    it('names the module and kind, shows the change by field names, keeps ids in the details', () => {
        start({
            autonomy: fakeAutonomy([
                { kind: 'living.fact', accepted: 2, edited: 0, rejected: 1, undone: 0, streak: 2 },
                { kind: 'wardrobe.outfit', accepted: 1, edited: 0, rejected: 0, undone: 0, streak: 1 },
            ]),
        });
        fakes.journal.records = [record];
        ui.openPult('journal');
        const row = body().querySelector<HTMLElement>('.maestro-journal-row')!;
        expect(row.querySelector('.maestro-muted')?.textContent).toMatch(/ · Живой канон · Новые факты о мире$/);
        const changes = row.querySelector<HTMLDetailsElement>('details.maestro-journal-changes')!;
        expect(changes.querySelector('summary')?.textContent).toBe('Что изменилось');
        expect(mainText(changes)).toContain('НазваниеПраздник урожая');
        expect(mainText(changes)).not.toContain('lf-123');
        expect(changes.querySelector('details.maestro-details')?.textContent).toContain('id: lf-123');
        const cells = [...body().querySelectorAll('.maestro-table tbody td:first-child')].map(
            (cell) => cell.textContent,
        );
        // Named kinds by their label; a kind nobody named yet keeps its id.
        expect(cells).toEqual(['Новые факты о мире', 'wardrobe.outfit']);
    });
});

describe('Settings in words', () => {
    it('sets how much to tell and whether details open; names autonomy kinds and hides module ids', () => {
        start({
            autonomy: fakeAutonomy([
                { kind: 'living.fact', accepted: 0, edited: 0, rejected: 0, undone: 0, streak: 0 },
                { kind: 'wardrobe.outfit', accepted: 0, edited: 0, rejected: 0, undone: 0, streak: 0 },
            ]),
        });
        ui.openPult('settings');
        const select = (label: string) =>
            [...body().querySelectorAll<HTMLSelectElement>('select')].find(
                (node) => node.getAttribute('aria-label') === label,
            );
        const level = select('О чём сообщать')!;
        expect([...level.options].map((option) => option.textContent)).toEqual(['Всё', 'Важное', 'Только срочное']);
        expect(level.value).toBe('all');
        level.value = 'urgent';
        level.dispatchEvent(new Event('change'));
        expect(env.settings.core().notifyLevel).toBe('urgent');
        expect(select('Новые факты о мире')).toBeDefined();
        expect(select('living.fact')).toBeUndefined();
        expect(select('wardrobe.outfit')).toBeDefined();
        expect(body().querySelector('.maestro-module-row')?.textContent).toContain('Живой канон');
        expect(body().querySelector('.maestro-module-row')?.textContent).not.toContain('M26');

        const technical = [...body().querySelectorAll<HTMLLabelElement>('label')].find((node) =>
            node.textContent?.includes('Показывать технические подробности'),
        )!;
        const input = technical.querySelector('input')!;
        input.checked = true;
        input.dispatchEvent(new Event('change'));
        expect(env.settings.core().showTechnical).toBe(true);
        expect(body().querySelector('.maestro-module-row')?.textContent).toContain('(M26)');
        expect(body().textContent).toContain('living.fact');
    });

    it('chooses the story language («Язык истории»): automatic by default, then Russian or English', () => {
        start();
        ui.openPult('settings');
        const story = [...body().querySelectorAll<HTMLSelectElement>('select')].find(
            (node) => node.getAttribute('aria-label') === 'Язык истории',
        )!;
        expect([...story.options].map((option) => option.textContent)).toEqual([
            'Автоматически',
            'Русский',
            'Английский',
        ]);
        expect(story.value).toBe('auto');
        expect(body().textContent).toContain('Язык, на котором ты играешь');
        const notified: string[] = [];
        env.settings.onChange((path) => notified.push(path));
        story.value = 'ru';
        story.dispatchEvent(new Event('change'));
        expect(env.settings.core().storyLanguage).toBe('ru');
        expect(notified).toContain('core.storyLanguage');
    });
});
