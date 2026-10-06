// @vitest-environment happy-dom
// The Maestro strip under chat messages (plan-2 §5): placement (also with DES chat bubbles), collapsed summary and
// expanded items, buttons, bodies and windows, the chatNotices setting, ST re-renders, repaints of the named messages
// only, and Ui.messageBadge as a memory-only line of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCoreSettings, migrateCore } from '../../src/core/settings';
import type { MessageStripProvider, StripItem, Ui } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { filterStripItems, stripSummary } from '../../src/ui/views/message-strip';
import { buildStDom, installUiEnv, rerenderMessage } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';

let env: UiTestEnv;
let ui: UiImpl;

const flush = async () => {
    for (let i = 0; i < 3; i++) await Promise.resolve();
};
const stripOf = (index: number) => document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"] .maestro-strip`);
const stripsOf = (index: number) => document.querySelectorAll(`#chat .mes[mesid="${index}"] .maestro-strip`);
const line = (index: number) => stripOf(index)!.querySelector<HTMLButtonElement>('.maestro-strip-line')!;
const itemsBox = (index: number) => stripOf(index)!.querySelector<HTMLElement>('.maestro-strip-items')!;
const rows = (index: number) => [...stripOf(index)!.querySelectorAll<HTMLElement>('.maestro-strip-item')];
const buttonIn = (root: ParentNode, text: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);

/** A provider whose items are set per message by the test; `emit` tells the strip what changed. */
function fakeProvider(id = 'test', order = 10) {
    const items = new Map<number, StripItem[]>();
    const listeners = new Set<(indexes?: number[]) => void>();
    const calls: number[] = [];
    const provider: MessageStripProvider = {
        id,
        order,
        items: (index) => {
            calls.push(index);
            return items.get(index) ?? [];
        },
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    return {
        provider,
        items,
        calls,
        emit: (indexes?: number[]) => {
            for (const listener of listeners) listener(indexes);
        },
        listeners,
    };
}

beforeEach(() => {
    buildStDom(3);
    env = installUiEnv('ru');
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
});

afterEach(() => ui.dispose());

describe('the strip', () => {
    it('adds nothing to messages without items', async () => {
        const fake = fakeProvider();
        ui.addMessageStripProvider(fake.provider);
        await flush();
        expect(document.querySelectorAll('.maestro-strip')).toHaveLength(0);
        expect(new Set(fake.calls)).toEqual(new Set([0, 1, 2]));
    });

    it('sits in .mes_block right after ST’s blocks, collapsed, with the single item’s text', async () => {
        const fake = fakeProvider();
        fake.items.set(1, [
            {
                id: 'a',
                kind: 'fact',
                text: 'Запомнил: в деревне празднуют урожай (пробно)',
                actions: [{ label: 'Верно', run: () => {} }],
            },
        ]);
        fake.items.set(2, [{ id: 'b', kind: 'roll', text: 'Бросок: 14 против 11', icon: 'fa-dice-d20' }]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        // A lone line with nothing to open stays a plain line (no button, no caret), with its own icon.
        const plain = stripOf(2)!.querySelector('.maestro-strip-line')!;
        expect(plain.tagName).toBe('DIV');
        expect(plain.classList.contains('maestro-strip-plain')).toBe(true);
        expect(plain.querySelector('.maestro-strip-caret')).toBeNull();
        expect(plain.querySelector('.fa-dice-d20')).not.toBeNull();
        expect(plain.textContent).toBe('Бросок: 14 против 11');
        const strip = stripOf(1)!;
        expect(strip.parentElement?.classList.contains('mes_block')).toBe(true);
        expect(strip.previousElementSibling?.classList.contains('mes_text')).toBe(true);
        expect(strip.closest('.mes_text')).toBeNull();
        expect(line(1).getAttribute('aria-expanded')).toBe('false');
        expect(itemsBox(1).hidden).toBe(true);
        expect(line(1).textContent).toContain('Запомнил: в деревне празднуют урожай (пробно)');
        expect(stripOf(0)).toBeNull();
        // The message text itself is untouched.
        expect(document.querySelector('#chat .mes[mesid="1"] .mes_text')?.textContent).toBe('text 1');
    });

    it('sums several items up in story words and lists them when expanded', async () => {
        const fake = fakeProvider();
        fake.items.set(2, [
            { id: 'p1', kind: 'proposal', text: 'Офелия переоделась' },
            { id: 'p2', kind: 'proposal', text: 'Кай ранен' },
            { id: 'f1', kind: 'fact', text: 'Запомнил: праздник' },
            { id: 'r1', kind: 'roll', text: 'Бросок: 14 против 11' },
        ]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        expect(line(2).textContent).toBe('2 предложения·запомнил факт·бросок');
        expect(line(2).title).toBe('2 предложения · запомнил факт · бросок');
        line(2).click();
        expect(line(2).getAttribute('aria-expanded')).toBe('true');
        expect(itemsBox(2).hidden).toBe(false);
        expect(rows(2).map((row) => row.textContent)).toEqual([
            'Офелия переоделась',
            'Кай ранен',
            'Запомнил: праздник',
            'Бросок: 14 против 11',
        ]);
        line(2).click();
        expect(itemsBox(2).hidden).toBe(true);
    });

    it('runs a button, reports a failing one, and opens the body after a button of an item with a body', async () => {
        const run = vi.fn();
        const body = vi.fn((box: HTMLElement) => {
            box.textContent = 'Полная карточка';
        });
        const fake = fakeProvider();
        fake.items.set(0, [
            {
                id: 'c',
                kind: 'proposal',
                text: 'Офелия переоделась',
                actions: [
                    { label: 'Принять', run, primary: true },
                    {
                        label: 'Сломать',
                        run: () => {
                            throw new Error('boom');
                        },
                    },
                ],
                body,
            },
        ]);
        const messageClick = vi.fn();
        document.querySelector('#chat .mes[mesid="0"]')?.addEventListener('click', messageClick);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        line(0).click();
        expect(body).not.toHaveBeenCalled();
        const accept = buttonIn(stripOf(0)!, 'Принять')!;
        expect(accept.classList.contains('maestro-strip-primary')).toBe(true);
        accept.click();
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
        expect(messageClick).not.toHaveBeenCalled();
        // The strip was rebuilt with the body open (an editor may have appeared in it).
        expect(body).toHaveBeenCalledTimes(1);
        expect(stripOf(0)!.querySelector<HTMLElement>('.maestro-strip-body')?.hidden).toBe(false);
        expect(stripOf(0)!.textContent).toContain('Полная карточка');
        buttonIn(stripOf(0)!, 'Сломать')!.click();
        await flush();
        expect(env.toastr.error).toHaveBeenCalled();
        expect(String(env.toastr.error.mock.calls.at(-1)?.[0])).toContain('boom');
    });

    it('renders a body on demand and releases it when closed', async () => {
        const released = vi.fn();
        const fake = fakeProvider();
        fake.items.set(1, [
            {
                id: 'c',
                kind: 'question',
                text: 'Тот же персонаж?',
                body: (box) => {
                    box.textContent = 'Подробности';
                    return released;
                },
            },
        ]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        line(1).click();
        const toggle = stripOf(1)!.querySelector<HTMLButtonElement>('.maestro-strip-toggle')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        toggle.click();
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(stripOf(1)!.querySelector('.maestro-strip-body')?.textContent).toBe('Подробности');
        toggle.click();
        expect(released).toHaveBeenCalledTimes(1);
        expect(stripOf(1)!.querySelector<HTMLElement>('.maestro-strip-body')?.hidden).toBe(true);
    });

    it('opens a window section through openWindow, or the tab’s window when the item names no window', async () => {
        const fake = fakeProvider();
        fake.items.set(1, [
            { id: 'w', kind: 'fact', text: 'Запомнил', open: { window: 'canon', tab: 'living', params: { x: 1 } } },
            { id: 't', kind: 'fact', text: 'Ещё', open: { window: '', tab: 'living' } },
        ]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        const openPult = vi.spyOn(ui, 'openPult').mockImplementation(() => {});
        const openWindow = vi.spyOn(ui as Ui & { openWindow: NonNullable<Ui['openWindow']> }, 'openWindow');
        openWindow.mockImplementation(() => {});
        line(1).click();
        const openers = () => [...stripOf(1)!.querySelectorAll<HTMLButtonElement>('.maestro-strip-open-window')];
        openers()[0]!.click();
        expect(openWindow).toHaveBeenCalledWith('canon', { tab: 'living', params: { x: 1 } });
        expect(openPult).not.toHaveBeenCalled();
        openers()[1]!.click();
        expect(openPult).toHaveBeenCalledWith('living');
    });

    it('follows the setting: everything, only what waits for a decision, nothing', async () => {
        const fake = fakeProvider();
        fake.items.set(1, [
            { id: 'p', kind: 'proposal', text: 'Предложение' },
            { id: 'q', kind: 'question', text: 'Вопрос' },
            { id: 'f', kind: 'fact', text: 'Факт' },
            { id: 'r', kind: 'roll', text: 'Бросок' },
        ]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        expect(rows(1)).toHaveLength(4);
        env.settings.core().chatNotices = 'pending';
        env.settings.notify('core.chatNotices');
        await flush();
        expect(rows(1).map((row) => row.textContent)).toEqual(['Предложение', 'Вопрос']);
        env.settings.core().chatNotices = 'none';
        env.settings.notify('core.chatNotices');
        await flush();
        expect(stripOf(1)).toBeNull();
        env.settings.core().chatNotices = 'all';
        env.settings.notify('core.chatNotices');
        await flush();
        expect(rows(1)).toHaveLength(4);
    });

    it('comes back after ST re-renders the message (edit, render, swipe, lazy loading)', async () => {
        const fake = fakeProvider();
        fake.items.set(1, [{ id: 'a', kind: 'roll', text: 'Бросок' }]);
        fake.items.set(5, [{ id: 'b', kind: 'roll', text: 'Поздний бросок' }]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        rerenderMessage(1);
        expect(stripOf(1)).toBeNull();
        await env.host.events.emit('MESSAGE_UPDATED', 1);
        await flush();
        expect(stripsOf(1)).toHaveLength(1);
        rerenderMessage(1);
        await env.host.events.emit('CHARACTER_MESSAGE_RENDERED', 1, 'normal');
        await flush();
        expect(stripsOf(1)).toHaveLength(1);
        rerenderMessage(1);
        await env.host.events.emit('MESSAGE_SWIPED', '1');
        await flush();
        expect(stripsOf(1)).toHaveLength(1);
        document
            .querySelector('#chat')
            ?.insertAdjacentHTML(
                'afterbegin',
                '<div class="mes" mesid="5"><div class="mes_block"><div class="mes_text">старое</div></div></div>',
            );
        await env.host.events.emit('MORE_MESSAGES_LOADED');
        await flush();
        expect(stripOf(5)?.textContent).toContain('Поздний бросок');
    });

    it('repaints only the messages a provider names and leaves unchanged strips (and their open state) alone', async () => {
        const fake = fakeProvider();
        const act = [{ label: 'Верно', run: () => {} }];
        fake.items.set(0, [{ id: 'a', kind: 'fact', text: 'Первый', actions: act }]);
        fake.items.set(1, [{ id: 'b', kind: 'fact', text: 'Второй', actions: act }]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        line(0).click();
        const first = stripOf(0);
        fake.calls.length = 0;
        fake.items.set(1, [{ id: 'b', kind: 'fact', text: 'Второй, изменённый', actions: act }]);
        fake.items.set(2, [{ id: 'c', kind: 'proposal', text: 'Новый', actions: act }]);
        fake.emit([1, 2]);
        fake.emit([2]);
        await flush();
        expect(fake.calls.sort()).toEqual([1, 2]);
        expect(stripOf(0)).toBe(first);
        expect(line(1).textContent).toContain('Второй, изменённый');
        expect(stripOf(2)?.textContent).toContain('Новый');
        // A repaint of everything finds message 0 unchanged: same node, still expanded.
        fake.emit();
        await flush();
        expect(stripOf(0)).toBe(first);
        expect(itemsBox(0).hidden).toBe(false);
        fake.items.delete(1);
        fake.emit([1]);
        await flush();
        expect(stripOf(1)).toBeNull();
    });

    it('orders providers and drops a provider’s items when it is removed', async () => {
        const later = fakeProvider('later', 30);
        const first = fakeProvider('first', 5);
        later.items.set(1, [{ id: 'x', kind: 'roll', text: 'Бросок' }]);
        first.items.set(1, [
            { id: 'y', kind: 'proposal', text: 'Предложение', actions: [{ label: 'Да', run: () => {} }] },
        ]);
        const off = ui.addMessageStripProvider(later.provider);
        ui.addMessageStripProvider(first.provider);
        await flush();
        line(1).click();
        expect(rows(1).map((row) => row.querySelector('.maestro-strip-item-text')?.textContent)).toEqual([
            'Предложение',
            'Бросок',
        ]);
        off();
        await flush();
        expect(rows(1).map((row) => row.querySelector('.maestro-strip-item-text')?.textContent)).toEqual([
            'Предложение',
        ]);
        expect(later.listeners.size).toBe(0);
    });

    it('lives outside DES chat bubbles: they neither hide nor duplicate it', async () => {
        // ST 1.19 message template with DES bubbles applied and DES's own sibling (the tracker JSON dropdown).
        document.querySelector('#chat')!.innerHTML = `
            <div class="mes" mesid="0" is_user="false"><div class="mesAvatarWrapper"></div><div class="swipe_left"></div>
              <div class="mes_block">
                <div class="ch_name"><div class="mes_buttons"></div><div class="mes_edit_buttons"></div></div>
                <details class="mes_reasoning_details"></details>
                <div class="mes_text" data-dooms-bubbles-applied="discord"><div class="dooms-bubbles dooms-bubbles-discord">
                  <div class="dooms-bubble">«Привет», — сказала Офелия.</div></div></div>
                <div class="mes_media_wrapper"></div><div class="mes_file_wrapper"></div><div class="mes_bias"></div>
                <details class="dooms-tracker-json" data-mesid="0"></details>
              </div><div class="swipeRightBlock"></div>
            </div>`;
        const fake = fakeProvider();
        fake.items.set(0, [{ id: 'a', kind: 'fact', text: 'Запомнил: таверна «Дракон»' }]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        const strip = stripOf(0)!;
        expect(strip.previousElementSibling?.classList.contains('mes_bias')).toBe(true);
        expect(strip.nextElementSibling?.classList.contains('dooms-tracker-json')).toBe(true);
        // DES re-applies its bubbles: it rewrites .mes_text's innerHTML only.
        const mesText = document.querySelector<HTMLElement>('#chat .mes_text')!;
        mesText.innerHTML =
            '<div class="dooms-bubbles dooms-bubbles-cards"><div class="dooms-card">«Привет»</div></div>';
        await env.host.events.emit('CHARACTER_MESSAGE_RENDERED', 0);
        await flush();
        expect(stripsOf(0)).toHaveLength(1);
        expect(stripOf(0)).toBe(strip);
        expect(mesText.querySelector('.maestro-strip')).toBeNull();
        // DES appends a scene header later: the strip stays right after ST's blocks.
        document
            .querySelector('#chat .mes_block')!
            .insertAdjacentHTML('beforeend', '<div class="dooms-scene-header"></div>');
        fake.items.set(0, [{ id: 'a', kind: 'fact', text: 'Запомнил: таверна «Дракон», уточнено' }]);
        fake.emit([0]);
        await flush();
        expect(stripsOf(0)).toHaveLength(1);
        expect(stripOf(0)!.previousElementSibling?.classList.contains('mes_bias')).toBe(true);
    });

    it('takes everything away on dispose and stops listening', async () => {
        const fake = fakeProvider();
        fake.items.set(1, [{ id: 'a', kind: 'fact', text: 'Факт' }]);
        ui.addMessageStripProvider(fake.provider);
        ui.messageBadge(2, { id: 'b', text: 'Бросок', kind: 'roll' });
        await flush();
        expect(document.querySelectorAll('.maestro-strip')).toHaveLength(2);
        ui.dispose();
        expect(document.querySelectorAll('.maestro-strip')).toHaveLength(0);
        expect(fake.listeners.size).toBe(0);
        rerenderMessage(1);
        await env.host.events.emit('MESSAGE_UPDATED', 1);
        await flush();
        expect(document.querySelectorAll('.maestro-strip')).toHaveLength(0);
        expect(env.mock.eventSource.events.get('message_updated') ?? []).toHaveLength(0);
    });

    it('rebuilds its words when the language changes', async () => {
        const fake = fakeProvider();
        fake.items.set(1, [
            { id: 'a', kind: 'fact', text: 'A' },
            { id: 'b', kind: 'fact', text: 'B' },
        ]);
        ui.addMessageStripProvider(fake.provider);
        await flush();
        const before = stripOf(1);
        expect(line(1).title).toBe('запомнил 2 факта');
        (ui as unknown as { relocalize(): void }).relocalize();
        await flush();
        expect(stripOf(1)).not.toBe(before);
        expect(stripsOf(1)).toHaveLength(1);
    });
});

describe('Ui.messageBadge as a strip line', () => {
    it('becomes a proposal line with its button first, highlighted', async () => {
        const run = vi.fn();
        ui.messageBadge(1, { id: 'qc', text: 'Анна — сестра Кая', action: { label: 'Применить', run } });
        await flush();
        expect(line(1).textContent).toContain('Анна — сестра Кая');
        line(1).click();
        const apply = buttonIn(stripOf(1)!, 'Применить')!;
        expect(apply.classList.contains('maestro-strip-primary')).toBe(true);
        expect(rows(1)[0]?.classList.contains('maestro-strip-kind-proposal')).toBe(true);
        apply.click();
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('passes kind, icon, tone and more buttons through; a line without buttons is a note', async () => {
        const dismiss = vi.fn();
        ui.messageBadge(2, {
            id: 'm12',
            text: 'В ответе брак: повтор',
            kind: 'question',
            icon: 'fa-triangle-exclamation',
            tone: 'warn',
            action: { label: 'Переделать', run: () => {} },
            actions: [{ label: 'Не брак', run: dismiss }],
        });
        ui.messageBadge(0, { id: 'note', text: 'Заметка' });
        await flush();
        line(2).click();
        const row = rows(2)[0]!;
        expect(row.classList.contains('maestro-strip-kind-question')).toBe(true);
        expect(row.classList.contains('maestro-strip-tone-warn')).toBe(true);
        expect(row.querySelector('.fa-triangle-exclamation')).not.toBeNull();
        expect([...row.querySelectorAll('button')].map((node) => node.textContent)).toEqual(['Переделать', 'Не брак']);
        buttonIn(row, 'Не брак')!.click();
        await flush();
        expect(dismiss).toHaveBeenCalledTimes(1);
        expect(stripOf(0)!.querySelector('.maestro-strip-plain .maestro-strip-kind-info')).not.toBeNull();
    });

    it('is replaced by the same id, removed by its remover, and kept to its own chat', async () => {
        const off = ui.messageBadge(1, { id: 'a', text: 'один' });
        ui.messageBadge(1, { id: 'a', text: 'два' });
        ui.messageBadge(1, { id: 'b', text: 'три' });
        await flush();
        line(1).click();
        expect(rows(1).map((row) => row.textContent)).toEqual(['два', 'три']);
        off();
        await flush();
        expect(rows(1).map((row) => row.textContent)).toEqual(['два', 'три']);
        env.mock.chatId = 'chat-2';
        rerenderMessage(1);
        await env.host.events.emit('CHAT_CHANGED', 'chat-2');
        await flush();
        expect(stripOf(1)).toBeNull();
        env.mock.chatId = 'chat-1';
        await env.host.events.emit('CHAT_CHANGED', 'chat-1');
        await flush();
        expect(stripOf(1)).not.toBeNull();
        const offB = ui.messageBadge(0, { id: 'c', text: 'четыре' });
        await flush();
        offB();
        await flush();
        expect(stripOf(0)).toBeNull();
    });

    it('also follows the setting (memory-only lines are no exception)', async () => {
        ui.messageBadge(1, { id: 'roll', text: 'Бросок', kind: 'roll' });
        ui.messageBadge(1, { id: 'ask', text: 'Применить?', action: { label: 'Да', run: () => {} } });
        env.settings.core().chatNotices = 'pending';
        env.settings.notify('core.chatNotices');
        await flush();
        expect(line(1).textContent).toContain('Применить?');
        expect(line(1).textContent).not.toContain('Бросок');
    });
});

describe('summary and filter helpers', () => {
    it('count per kind in the order of the plan, in Russian plural forms', () => {
        const items = (kind: StripItem['kind'], count: number): StripItem[] =>
            Array.from({ length: count }, (_, at) => ({ id: `${kind}${at}`, kind, text: kind }));
        expect(
            stripSummary(env.i18n, [...items('roll', 5), ...items('fact', 21), ...items('proposal', 2)]).map(
                (part) => part.text,
            ),
        ).toEqual(['2 предложения', 'запомнил 21 факт', '5 бросков']);
        expect(stripSummary(env.i18n, [...items('question', 3), ...items('info', 1)]).map((part) => part.text)).toEqual(
            ['3 вопроса', 'заметка'],
        );
    });

    it('filter by the setting', () => {
        const all: StripItem[] = ['proposal', 'question', 'fact', 'change', 'roll', 'info'].map((kind) => ({
            id: kind,
            kind: kind as StripItem['kind'],
            text: kind,
        }));
        expect(filterStripItems(all, 'all')).toHaveLength(6);
        expect(filterStripItems(all, undefined)).toHaveLength(6);
        expect(filterStripItems(all, 'pending').map((item) => item.kind)).toEqual(['proposal', 'question']);
        expect(filterStripItems(all, 'none')).toEqual([]);
    });

    it('the setting defaults to «everything» and a broken value is repaired', () => {
        expect(defaultCoreSettings().chatNotices).toBe('all');
        const broken = { ...defaultCoreSettings(), chatNotices: 'loud' as never };
        expect(migrateCore(broken).chatNotices).toBe('all');
        const kept = { ...defaultCoreSettings(), chatNotices: 'pending' as const };
        expect(migrateCore(kept).chatNotices).toBe('pending');
    });
});
