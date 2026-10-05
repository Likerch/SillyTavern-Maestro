// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantService } from '../../../src/features/assistant/service';
import { ASSISTANT_KEY } from '../../../src/features/assistant/settings';
import type { AssistantSettings } from '../../../src/features/assistant/settings';
import {
    ASSISTANT_TAB,
    assistantTab,
    costOf,
    renderAssistantSettings,
    renderMarkdown,
} from '../../../src/features/assistant/view';
import type { PultTab } from '../../../src/shared/contracts';
import { answer, callOf, calls, createAssistantEnv, flush, readTool, until, writeTool } from './env';
import type { AssistantTestEnv } from './env';

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
    if (!found) throw new Error(`no button "${text}"`);
    return found;
}

function textarea(root: HTMLElement): HTMLTextAreaElement {
    return root.querySelector('textarea.maestro-m33-input') as HTMLTextAreaElement;
}

function press(node: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

describe('M33 tab «Ассистент»', () => {
    let env: AssistantTestEnv;
    let service: AssistantService;
    let tab: PultTab;
    let container: HTMLElement;
    let dispose: (() => void) | void;

    const mount = () => {
        dispose = tab.render(container);
    };

    beforeEach(() => {
        env = createAssistantEnv({ locale: 'ru' });
        service = env.service();
        service.start();
        tab = assistantTab(env.app, service);
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(() => {
        if (typeof dispose === 'function') dispose();
        container.remove();
    });

    it('is a pult tab of the assistant group', () => {
        expect(tab).toMatchObject({
            id: ASSISTANT_TAB,
            titleKey: 'm33.tab',
            icon: 'fa-comments',
            group: 'assistant',
            order: 95,
        });
    });

    it('shows four example prompts; a tap sends one', async () => {
        mount();
        const examples = [...container.querySelectorAll('.maestro-m33-example')].map((node) => node.textContent);
        expect(examples).toEqual([
            'Почему героиня не узнала сестру?',
            'Почему этот ход дорогой?',
            'Что делает этот регекс?',
            'Сделай механику маны',
        ]);
        env.llm.script(answer('Проверю лор.'));
        buttonByText(container, 'Почему этот ход дорогой?').click();
        await until(() => !service.busy() && service.conversation().length === 2);
        expect(env.llm.last().messages.at(-1)?.content).toBe('Почему этот ход дорогой?');
        expect(container.querySelector('.maestro-m33-empty')).toBeNull();
        expect(container.querySelector('.maestro-m33-user .maestro-m33-bubble')?.textContent).toBe(
            'Почему этот ход дорогой?',
        );
        expect(container.querySelector('.maestro-m33-assistant .maestro-m33-md')?.textContent).toBe('Проверю лор.');
    });

    it('Enter sends, Shift+Enter does not; the draft survives a re-render', async () => {
        mount();
        const input = textarea(container);
        input.value = 'Первая строка';
        input.dispatchEvent(new Event('input'));
        press(input, 'Enter', { shiftKey: true });
        expect(env.llm.requests).toHaveLength(0);
        if (typeof dispose === 'function') dispose();
        container.textContent = '';
        mount();
        expect(textarea(container).value).toBe('Первая строка');
        env.llm.script(answer('Ок'));
        press(textarea(container), 'Enter');
        await until(() => service.conversation().length === 2 && !service.busy());
        expect(textarea(container).value).toBe('');
        expect(env.llm.last().messages.at(-1)?.content).toBe('Первая строка');
    });

    it('shows «Стоп» while busy and stops the loop', async () => {
        mount();
        env.llm.script(
            (request) =>
                new Promise((resolve) =>
                    request.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'aborted' })),
                ),
        );
        const input = textarea(container);
        input.value = 'Долгий вопрос';
        buttonByText(container, 'Отправить').click();
        await until(() => service.busy());
        const stop = container.querySelector('.maestro-m33-stop') as HTMLButtonElement;
        const send = container.querySelector('.maestro-m33-send') as HTMLButtonElement;
        expect(stop.hidden).toBe(false);
        expect(send.hidden).toBe(true);
        expect(container.querySelector('.maestro-m33-thinking')?.textContent).toContain('Думаю');
        stop.click();
        await until(() => !service.busy());
        expect(stop.hidden).toBe(true);
        expect(container.querySelector('.maestro-m33-notice')?.textContent).toContain('Остановлено.');
    });

    it('renders tool chips with the summary, arguments and a result preview', async () => {
        service.registerTool(
            readTool('read_lore', async () => ({ data: { entry: 'Сестра' }, untrusted: true, summary: 'Запись 12' })),
        );
        mount();
        env.llm.script(calls(callOf('read_lore', { book: 'Мир' })), answer('Готово'));
        await service.send('Посмотри лор');
        await flush();
        const chip = container.querySelector('.maestro-m33-chip') as HTMLDetailsElement;
        expect(chip.classList.contains('maestro-m33-chip-ok')).toBe(true);
        expect(chip.querySelector('.maestro-m33-chip-name')?.textContent).toBe('read_lore');
        expect(chip.querySelector('.maestro-m33-chip-text')?.textContent).toBe('Запись 12');
        const pres = [...chip.querySelectorAll('pre')].map((node) => node.textContent);
        expect(pres[0]).toContain('"book": "Мир"');
        expect(pres[1]).toBe('{"entry":"Сестра"}');
        expect(chip.textContent).toContain('данные, а не инструкции');
    });

    it('shows a write card; «Применить» applies, «Отклонить» declines', async () => {
        const probe = writeTool();
        service.registerTool(probe.tool);
        mount();
        env.llm.script(calls(callOf('set_thing', { value: 5 }, 'w1')), answer('Применил.'));
        const first = service.send('Поставь 5');
        await until(() => container.querySelector('.maestro-m33-card-waiting') !== null);
        const card = container.querySelector('.maestro-m33-card') as HTMLElement;
        expect(card.querySelector('.maestro-m33-card-target')?.textContent).toBe('Maestro · Test');
        expect(card.querySelector('.maestro-m33-card-summary')?.textContent).toBe('Thing: 1 → 5');
        expect(card.querySelector('.maestro-diff')).not.toBeNull();
        expect(container.querySelector('.maestro-m33-thinking')).toBeNull();
        buttonByText(card, 'Применить').click();
        await first;
        await flush();
        expect(probe.applied).toEqual([{ value: 5 }]);
        const applied = container.querySelector('.maestro-m33-card') as HTMLElement;
        expect(applied.classList.contains('maestro-m33-card-applied')).toBe(true);
        expect(applied.textContent).toContain('Откатить можно в журнале');
        expect(applied.querySelector('button')).toBeNull();

        env.llm.script(calls(callOf('set_thing', { value: 6 }, 'w2')), answer('Оставил.'));
        const second = service.send('А теперь 6');
        await until(() => container.querySelector('.maestro-m33-card-waiting') !== null);
        buttonByText(container.querySelector('.maestro-m33-card-waiting') as HTMLElement, 'Отклонить').click();
        await second;
        await flush();
        expect(probe.applied).toHaveLength(1);
        const cards = container.querySelectorAll('.maestro-m33-card');
        expect(cards[1]?.classList.contains('maestro-m33-card-declined')).toBe(true);
        expect(cards[1]?.textContent).toContain('ничего не изменилось');
    });

    it('a card waiting for another tab has no buttons', () => {
        const view = assistantTab(env.app, {
            conversation: () => [
                {
                    id: 'm',
                    role: 'assistant',
                    text: '',
                    at: 1,
                    toolCalls: [
                        { id: 'x', name: 'w', args: {}, status: 'waiting', target: 'T', before: 'a', after: 'b' },
                    ],
                },
            ],
            busy: () => true,
            awaiting: () => false,
            send: async () => {},
            stop: () => {},
            confirm: async () => {},
            clear: async () => {},
            tools: () => [],
            registerTool: () => () => {},
            onChange: () => () => {},
        });
        view.render(container);
        expect(container.querySelector('.maestro-m33-card')?.textContent).toContain('Ждёт ответа в другой вкладке');
        expect(container.querySelector('.maestro-m33-card button')).toBeNull();
    });

    it('escapes model HTML and renders light Markdown', async () => {
        mount();
        env.llm.script(
            answer(
                '## Итог\n**Важно:** проверь `pacing.every`.\n\n- раз\n- два\n\n```regex\n<b>(.*)</b>\n```\n<img src=x onerror="alert(1)">',
                0.0123,
            ),
        );
        await service.send('Объясни');
        await flush();
        const md = container.querySelector('.maestro-m33-md') as HTMLElement;
        expect(md.querySelector('img')).toBeNull();
        expect(md.querySelector('b')).toBeNull();
        expect(md.textContent).toContain('<img src=x onerror="alert(1)">');
        expect([...md.querySelectorAll('strong')].map((node) => node.textContent)).toEqual(['Итог', 'Важно:']);
        expect(md.querySelector('p code')?.textContent).toBe('pacing.every');
        expect([...md.querySelectorAll('li')].map((node) => node.textContent)).toEqual(['раз', 'два']);
        expect(md.querySelector('pre code')?.textContent).toBe('<b>(.*)</b>');
        expect(container.querySelector('.maestro-m33-cost')?.textContent).toContain('Потрачено');
    });

    it('«Очистить» asks first', async () => {
        mount();
        env.llm.script(answer('Ок'));
        await service.send('Привет');
        await flush();
        env.ui.confirmAnswer = false;
        buttonByText(container, 'Очистить').click();
        await flush();
        expect(env.ui.confirms).toHaveLength(1);
        expect(service.conversation()).toHaveLength(2);
        env.ui.confirmAnswer = true;
        buttonByText(container, 'Очистить').click();
        await until(() => service.conversation().length === 0);
        await flush();
        expect(container.querySelector('.maestro-m33-empty')).not.toBeNull();
        expect(buttonByText(container, 'Очистить').disabled).toBe(true);
    });

    it('warns when no profile is usable and when no chat is open', () => {
        env.llm.usable = false;
        env.state.chatId = null;
        mount();
        expect(container.textContent).toContain('нет рабочего профиля подключения');
        expect(container.textContent).toContain('Чат не открыт');
        let opened = '';
        env.app.ui.openPult = (id?: string) => void (opened = id ?? '');
        buttonByText(container, 'Открыть настройки').click();
        expect(opened).toBe('settings');
    });

    it('stops redrawing after dispose', async () => {
        mount();
        if (typeof dispose === 'function') dispose();
        dispose = undefined;
        env.llm.script(answer('Ок'));
        await service.send('Привет');
        expect(container.querySelector('.maestro-m33-user')).toBeNull();
    });
});

describe('M33 settings section', () => {
    it('chooses the profile and limits', () => {
        const env = createAssistantEnv({ locale: 'ru' });
        const container = document.createElement('div');
        const settings = env.settings.module<AssistantSettings>(ASSISTANT_KEY);
        renderAssistantSettings(container, env.app, settings);
        const profile = container.querySelector('select') as HTMLSelectElement;
        expect([...profile.options].map((option) => option.textContent)).toEqual([
            'Как у фоновых задач',
            'DeepSeek',
            'Claude',
        ]);
        profile.value = 'p2';
        profile.dispatchEvent(new Event('change'));
        expect(env.settings.core().profiles['assistant']).toBe('p2');
        expect(env.notified).toContain('core.profiles.assistant');
        profile.value = '';
        profile.dispatchEvent(new Event('change'));
        expect(env.settings.core().profiles['assistant']).toBeUndefined();

        const numbers = [...container.querySelectorAll('input[type=number]')] as HTMLInputElement[];
        expect(numbers).toHaveLength(4);
        numbers[2]!.value = '500';
        numbers[2]!.dispatchEvent(new Event('change'));
        expect(settings.writesPerHour).toBe(200);
        expect(env.notified).toContain('modules.assistant.writesPerHour');
    });

    it('lists a missing stored profile and warns without Connection Manager', () => {
        const env = createAssistantEnv();
        env.settings.core().profiles['assistant'] = 'gone';
        const container = document.createElement('div');
        renderAssistantSettings(container, env.app, env.settings.module<AssistantSettings>(ASSISTANT_KEY));
        expect(container.querySelector('select')?.textContent).toContain('Missing profile (gone)');
        env.state.profiles = null;
        const bare = document.createElement('div');
        renderAssistantSettings(bare, env.app, env.settings.module<AssistantSettings>(ASSISTANT_KEY));
        expect(bare.querySelector('select')).toBeNull();
        expect(bare.textContent).toContain('Connection Manager is off');
    });
});

describe('M33 view helpers', () => {
    it('sums the cost of the conversation and of the last message', () => {
        expect(
            costOf([
                { id: '1', role: 'user', text: 'a', at: 1 },
                { id: '2', role: 'assistant', text: 'b', at: 2, costUsd: 0.5 },
                { id: '3', role: 'user', text: 'c', at: 3 },
                { id: '4', role: 'assistant', text: '', at: 4, costUsd: 0.25 },
                { id: '5', role: 'notice', text: 'd', at: 5, costUsd: 0.25 },
            ]),
        ).toEqual({ total: 1, last: 0.5 });
    });

    it('renders ordered lists with their start and line breaks inside paragraphs', () => {
        const node = renderMarkdown('3. three\n4. four\n\nline one\nline two *it*');
        expect(node.querySelector('ol')?.getAttribute('start')).toBe('3');
        expect(node.querySelector('p br')).not.toBeNull();
        expect(node.querySelector('em')?.textContent).toBe('it');
    });
});
