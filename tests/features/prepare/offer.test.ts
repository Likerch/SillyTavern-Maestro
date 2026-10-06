// @vitest-environment happy-dom
// The offer under the greeting (plan-2 §7, В13/В14): one line on the last message of a new chat — «Подготовить
// историю к игре?» [Подготовить] [Не сейчас], or the saved preparation of the character [Применить сохранённое]
// [Разобрать заново]; the run's progress and the ready plan in the same place; gone once the player writes, the plan is
// applied or he said «Не сейчас»; with the strip off a quiet notice once per chat instead.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OFFER_POINTER } from '../../../src/features/prepare/controller';
import { PrepareOffer } from '../../../src/features/prepare/offer';
import type { MessageStripProvider, StripItem, Unsubscribe } from '../../../src/shared/contracts';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { greetingMessage, settle } from './helpers';
import { fakeStand, samplePlan } from './ui-helpers';
import type { FakeStand } from './ui-helpers';

let stand: FakeStand;
let offer: PrepareOffer;
let offs: Unsubscribe[] = [];
let provider: MessageStripProvider;
let changes: (number[] | undefined)[];

async function start(options: { windows?: boolean; strip?: boolean } = {}): Promise<void> {
    stand = fakeStand(options);
    offer = new PrepareOffer(stand.ui);
    provider = offer.provider();
    changes = [];
    offs = [provider.onChange((indexes) => changes.push(indexes)), ...offer.install()];
    await flush();
}

async function flush(): Promise<void> {
    await settle(5);
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function only(index = 0): StripItem {
    const items = provider.items(index);
    expect(items).toHaveLength(1);
    return items[0]!;
}

function labels(item: StripItem): string[] {
    return (item.actions ?? []).map((action) => action.label);
}

function pointer(): unknown {
    const root = stand.env.mock.chatMetadata.maestro as { pointers?: Record<string, unknown> } | undefined;
    return root?.pointers?.[OFFER_POINTER];
}

afterEach(() => {
    for (const off of offs.splice(0)) off();
});

describe('prepare offer: under the greeting', () => {
    beforeEach(async () => {
        await start();
    });

    it('asks on the last message of a new chat, nowhere else', () => {
        const item = only(0);
        expect(item).toMatchObject({ id: 'offer', kind: 'question', tone: 'accent' });
        expect(item.text).toBe(
            'Подготовить историю к игре? Maestro прочитает карточку и лор и заполнит персонажей, мир, места, механики…',
        );
        expect(labels(item)).toEqual(['Подготовить', 'Не сейчас']);
        const box = document.createElement('div');
        item.body?.(box);
        expect(box.textContent).toContain('Сначала покажу, что прочитаю');
        expect(provider.items(1)).toEqual([]);
        expect(provider.items(-1)).toEqual([]);
    });

    it('«Подготовить» opens the preparation window', async () => {
        await only().actions![0]!.run();
        expect(stand.shell.opened).toEqual([{ id: 'prepare', options: undefined }]);
    });

    it('«Не сейчас» hides it for this chat (chat metadata) and repaints the message', async () => {
        changes.length = 0;
        await only().actions![1]!.run();
        await flush();
        expect(pointer()).toEqual({ hidden: true });
        expect(provider.items(0)).toEqual([]);
        expect(changes.some((indexes) => indexes?.includes(0))).toBe(true);
    });

    it('goes once the player writes', async () => {
        only(0);
        changes.length = 0;
        stand.env.mock.chat.push({ ...greetingMessage({ name: 'Кай', data: { first_mes: 'Привет' } }), is_user: true });
        stand.engine.eligible = { ok: false, reason: 'started' };
        await stand.env.mock.eventSource.emit(EVENT_TYPES.MESSAGE_SENT!, 1);
        expect(changes).toEqual([[0]]);
        expect(provider.items(0)).toEqual([]);
        expect(provider.items(1)).toEqual([]);
    });

    it('shows the run, then the ready plan, and goes once the plan is applied', async () => {
        await stand.engine.start();
        await flush();
        const running = only();
        expect(running).toMatchObject({ kind: 'info', open: { window: 'prepare', tab: 'prepare' } });
        expect(running.text).toBe('Готовлю историю к игре: Читаю карточку и книги…');
        changes.length = 0;
        stand.engine.progress(1, 2);
        expect(changes.length).toBeGreaterThan(0);
        expect(only().text).toBe('Готовлю историю к игре: Читаю часть 2 из 2…');
        stand.engine.finish(samplePlan());
        const ready = only();
        expect(ready).toMatchObject({ kind: 'question' });
        expect(ready.text).toBe('Подготовка готова (пунктов: 7) — посмотри и примени');
        expect(labels(ready)).toEqual(['Посмотреть', 'Не сейчас']);
        await stand.engine.apply([{ id: 'world' }]);
        expect(provider.items(0)).toEqual([]);
    });

    it('stays off when the module setting says so', async () => {
        stand.env.prepareSettings().offer = false;
        expect(provider.items(0)).toEqual([]);
    });
});

describe('prepare offer: the saved preparation of the character', () => {
    beforeEach(async () => {
        stand = fakeStand();
        stand.engine.saved = {
            avatar: 'silver-harbor.png',
            cardName: 'Хроники',
            savedAt: 1,
            items: samplePlan().items.slice(0, 3),
            book: null,
            changed: ['Сценарий'],
        };
        offer = new PrepareOffer(stand.ui);
        provider = offer.provider();
        changes = [];
        offs = [provider.onChange((indexes) => changes.push(indexes)), ...offer.install()];
        await flush();
    });

    it('offers to apply it, to analyse anew, or not now', () => {
        const item = only();
        expect(item.text).toBe('Есть подготовка для этого персонажа (пунктов: 3) — применить?');
        expect(labels(item)).toEqual(['Применить сохранённое', 'Разобрать заново', 'Не сейчас']);
        const box = document.createElement('div');
        item.body?.(box);
        expect(box.textContent).toBe('С тех пор изменилось: Сценарий');
    });

    it('applies it without the model; the line goes', async () => {
        await only().actions![0]!.run();
        await flush();
        expect(stand.engine.appliedSaved).toBe(1);
        expect(stand.ui.draft().summary?.done.map((line) => line.text)).toEqual(['Элизабет: в канон']);
        expect(provider.items(0)).toEqual([]);
    });

    it('«Разобрать заново» opens the first step with a full reading', async () => {
        await only().actions![1]!.run();
        expect(stand.ui.draft()).toMatchObject({ restart: true, reuse: false });
        expect(stand.shell.opened.map((entry) => entry.id)).toEqual(['prepare']);
    });
});

describe('prepare offer: without windows or the strip', () => {
    it('opens the pult tab when the shell has no windows', async () => {
        await start({ windows: false });
        await only().actions![0]!.run();
        expect(stand.shell.pult).toEqual(['prepare']);
        expect(stand.shell.opened).toEqual([]);
    });

    it('gives a quiet notice once per new chat when the strip is switched off', async () => {
        stand = fakeStand();
        stand.env.settings.core().chatNotices = 'none';
        offer = new PrepareOffer(stand.ui);
        offs = offer.install();
        await flush();
        const notices = stand.env.ui.notices.filter((notice) => notice.text.startsWith('Новый чат'));
        expect(notices).toHaveLength(1);
        expect(notices[0]!.options).toMatchObject({ importance: 'info', action: { label: 'Подготовить' } });
        notices[0]!.options!.action!.run();
        expect(stand.shell.opened.map((entry) => entry.id)).toEqual(['prepare']);
        expect(pointer()).toEqual({ noticed: true });
        await offer.chatOpened();
        await flush();
        expect(stand.env.ui.notices.filter((notice) => notice.text.startsWith('Новый чат'))).toHaveLength(1);
    });

    it('gives the notice in a shell without the strip, none while the strip shows the line', async () => {
        await start({ strip: false });
        expect(stand.env.ui.notices.filter((notice) => notice.text.startsWith('Новый чат'))).toHaveLength(1);
        for (const off of offs.splice(0)) off();
        await start();
        expect(stand.env.ui.notices.filter((notice) => notice.text.startsWith('Новый чат'))).toHaveLength(0);
    });

    it('no notice in a chat that is not new', async () => {
        stand = fakeStand({ strip: false });
        stand.engine.eligible = { ok: false, reason: 'started' };
        offer = new PrepareOffer(stand.ui);
        offs = offer.install();
        await flush();
        expect(stand.env.ui.notices).toEqual([]);
    });
});
