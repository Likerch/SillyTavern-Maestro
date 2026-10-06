// @vitest-environment happy-dom
// Inbox cards in the strip under their message (plan-2 §5): the Inbox buttons on the line (accept/reject labels,
// «Изменить», «Завтра»), the compact card as the body, identity questions placed by their payload, cards without a
// message staying in the Inbox, and the setting control.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxCard } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { SNOOZE_MS } from '../../src/ui/views/inbox';
import { stripMessageOf } from '../../src/ui/views/inbox-strip';
import { resetRegistries } from '../../src/ui/views/registries';
import { buildStDom, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes, FakeInbox, inboxCard } from '../helpers/ui-fakes';
import type { CoreFakes } from '../helpers/ui-fakes';

/** Records the edited payload accept() receives. */
class EditingInbox extends FakeInbox {
    readonly edits: { id: string; edited: unknown }[] = [];
    override async accept(id: string, edited?: unknown): Promise<boolean> {
        if (edited !== undefined) this.edits.push({ id, edited });
        return super.accept(id);
    }
}

let env: UiTestEnv;
let ui: UiImpl;
let fakes: CoreFakes & { inbox: EditingInbox };

const flush = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
};
const stripOf = (index: number) => document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"] .maestro-strip`);
const line = (index: number) => stripOf(index)!.querySelector<HTMLButtonElement>('.maestro-strip-line')!;
const rows = (index: number) => [...stripOf(index)!.querySelectorAll<HTMLElement>('.maestro-strip-item')];
const buttonIn = (root: ParentNode, text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);

function card(id: string, sourceMessage: number | undefined, overrides: Partial<InboxCard> = {}): InboxCard {
    return inboxCard(id, {
        title: `Офелия переоделась (${id})`,
        description: 'Белая блузка и чёрная юбка. Запомнить как наряд?',
        sourceMessage,
        ...overrides,
    });
}

function start(inbox = new EditingInbox()): void {
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
    fakes = coreFakes(env, { inbox }) as CoreFakes & { inbox: EditingInbox };
    ui.registerCoreViews(fakes);
}

beforeEach(() => {
    resetRegistries();
    buildStDom(4);
    env = installUiEnv('ru');
    env.settings.core().firstRunDone = true;
});

afterEach(() => ui.dispose());

describe('Inbox cards under their message', () => {
    it('shows cards of a message there; cards without a message and deferred ones stay in the Inbox', async () => {
        start();
        fakes.inbox.set([
            card('a', 1),
            card('b', 1, { createdAt: 1_700_000_000_500 }),
            card('c', undefined),
            card('d', 2, { deferred: true }),
        ]);
        await flush();
        expect(line(1).title).toBe('2 предложения');
        expect(stripOf(0)).toBeNull();
        expect(stripOf(2)).toBeNull();
        expect(document.querySelectorAll('.maestro-strip')).toHaveLength(1);
        line(1).click();
        expect(rows(1).map((row) => row.querySelector('.maestro-strip-item-text')?.textContent)).toEqual([
            'Офелия переоделась (a)',
            'Офелия переоделась (b)',
        ]);
    });

    it('has the Inbox buttons with the card’s own labels', async () => {
        start();
        fakes.inbox.set([card('a', 1, { acceptLabel: 'Тот же', rejectLabel: 'Другой' })]);
        await flush();
        line(1).click();
        const labels = [...rows(1)[0]!.querySelectorAll('.maestro-strip-action')].map((node) => node.textContent);
        expect(labels).toEqual(['Тот же', 'Другой', 'Завтра']);
        buttonIn(stripOf(1)!, 'Тот же')!.click();
        await flush();
        expect(fakes.inbox.accepted).toEqual(['a']);
        expect(stripOf(1)).toBeNull();
    });

    it('rejects and snoozes until tomorrow; a stale card is reported', async () => {
        start();
        fakes.inbox.set([card('a', 1), card('b', 2), card('c', 3)]);
        fakes.inbox.stale.add('c');
        await flush();
        line(1).click();
        buttonIn(stripOf(1)!, 'Отклонить')!.click();
        line(2).click();
        buttonIn(stripOf(2)!, 'Завтра')!.click();
        line(3).click();
        buttonIn(stripOf(3)!, 'Принять')!.click();
        await flush();
        expect(fakes.inbox.rejected).toEqual(['a']);
        expect(fakes.inbox.snoozed).toEqual([{ id: 'b', ms: SNOOZE_MS }]);
        expect(stripOf(1)).toBeNull();
        expect(stripOf(2)).toBeNull();
        expect(String(env.toastr.warning.mock.calls.at(-1)?.[0])).toContain('устарело');
    });

    it('opens the compact card as the body: the story, the evidence and «Подробнее», no buttons of its own', async () => {
        start();
        fakes.inbox.set([card('a', 1, { payload: { evidence: '«Она надела блузку».' }, details: 'book: Мир' })]);
        await flush();
        line(1).click();
        stripOf(1)!.querySelector<HTMLButtonElement>('.maestro-strip-toggle')!.click();
        const body = stripOf(1)!.querySelector<HTMLElement>('.maestro-strip-body')!;
        expect(body.querySelector('.maestro-inbox-compact')).not.toBeNull();
        expect(body.querySelector('.maestro-card-title')).toBeNull();
        expect(body.querySelector('.maestro-card-actions')).toBeNull();
        expect(body.textContent).toContain('Белая блузка и чёрная юбка');
        expect(body.textContent).toContain('«Она надела блузку».');
        expect(body.querySelector('details')).not.toBeNull();
        expect(body.textContent).not.toContain('Сообщение №');
    });

    it('«Изменить» opens the editor in the body; saving accepts the edited value', async () => {
        start();
        fakes.inbox.set([card('a', 2, { payload: { value: 'Белая блузка', editable: true } })]);
        await flush();
        line(2).click();
        buttonIn(stripOf(2)!, 'Изменить')!.click();
        await flush();
        const area = stripOf(2)!.querySelector<HTMLTextAreaElement>('.maestro-strip-body textarea')!;
        expect(area.value).toBe('Белая блузка');
        area.value = 'Белая блузка и шарф';
        area.dispatchEvent(new Event('input'));
        const save = [...stripOf(2)!.querySelectorAll<HTMLButtonElement>('.maestro-strip-body button')].find((node) =>
            node.textContent?.includes('Save and accept'),
        )!;
        save.click();
        await flush();
        expect(fakes.inbox.edits).toEqual([{ id: 'a', edited: { value: 'Белая блузка и шарф', editable: true } }]);
    });

    it('asks an identity question under the message its payload names', async () => {
        start();
        const question = card('q', undefined, {
            kind: 'world.sameAs',
            title: 'Офелия здесь — тот же персонаж, что в книге «Архив персонажей»?',
            payload: { name: 'Офелия', messageIndex: 3 },
            acceptLabel: 'Тот же',
            rejectLabel: 'Другой',
        });
        expect(stripMessageOf(question)).toBe(3);
        expect(stripMessageOf({ ...question, kind: 'canon.fact' })).toBeUndefined();
        expect(stripMessageOf({ ...question, payload: { messageIndex: -1 } })).toBeUndefined();
        fakes.inbox.set([question]);
        await flush();
        expect(line(3).title).toBe('Офелия здесь — тот же персонаж, что в книге «Архив персонажей»?');
        line(3).click();
        expect(rows(3)[0]?.classList.contains('maestro-strip-kind-question')).toBe(true);
    });

    it('comes back with the stored Inbox after a reload, and «only what waits» keeps it', async () => {
        const inbox = new EditingInbox();
        start(inbox);
        inbox.set([card('a', 1)]);
        await flush();
        ui.dispose();
        expect(stripOf(1)).toBeNull();
        env.settings.core().chatNotices = 'pending';
        start(inbox);
        await flush();
        expect(stripOf(1)).not.toBeNull();
    });
});

describe('the setting in Settings', () => {
    it('chooses everything, only what waits for a decision, or nothing', () => {
        start();
        ui.openPult('settings');
        const select = [...document.querySelectorAll<HTMLSelectElement>('.maestro-pult-body select')].find(
            (node) => node.getAttribute('aria-label') === 'Строка Maestro под сообщениями',
        )!;
        expect([...select.options].map((option) => option.textContent)).toEqual([
            'Всё',
            'Только то, что ждёт решения',
            'Ничего',
        ]);
        expect(select.value).toBe('all');
        select.value = 'pending';
        select.dispatchEvent(new Event('change'));
        expect(env.settings.core().chatNotices).toBe('pending');
    });
});
