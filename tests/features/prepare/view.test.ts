// @vitest-environment happy-dom
// The «Подготовка» pult tab: why a chat cannot be prepared, the estimate, the analysis, the plan by sections with
// «уже есть», «Применить для чата», the result and «Готово к игре».
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareTab } from '../../../src/features/prepare/view';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createPrepareEnv, greetingMessage, settle, startPrepare } from './helpers';
import type { PrepareEnv, Started } from './helpers';

let env: PrepareEnv;
let started: Started;
let container: HTMLElement;
let close: Unsubscribe | void;

beforeEach(() => {
    env = createPrepareEnv();
    started = startPrepare(env);
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(() => {
    if (typeof close === 'function') close();
    close = undefined;
    container.remove();
    started.stop();
});

async function settleUi(): Promise<void> {
    await settle(20);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle(20);
}

function buttonOf(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label);
    if (!button) throw new Error(`no button «${label}»`);
    return button;
}

describe('prepare: the pult tab', () => {
    it('estimates, analyses, shows the plan and applies it for the chat', async () => {
        close = prepareTab(env.app, started.service).render(container);
        await settleUi();
        expect(container.textContent).toContain('До первого хода Maestro читает карточку');
        buttonOf('Оценить').click();
        await settleUi();
        expect(container.textContent).toMatch(/Запросов: 2, источников: \d+, примерно/);
        buttonOf('Разобрать').click();
        await started.service.whenDone();
        await settleUi();
        expect(container.textContent).toContain('Персонажи (');
        expect(container.textContent).toContain('• ');
        expect(container.textContent).toContain('Подготовка ещё не применена');
        buttonOf('Применить для чата').click();
        await settleUi();
        await settleUi();
        expect(container.textContent).toContain('Итог');
        expect(container.textContent).toContain('Элизабет: в канон, паспорт');
        expect(container.textContent).toContain('[уже в каноне]');
        expect(container.textContent).not.toContain('Подготовка ещё не применена');
    });

    it('says why a started chat is not prepared', async () => {
        env.mock.chat.push({ ...greetingMessage({ name: 'Кай', data: { first_mes: 'Привет' } }), is_user: true });
        close = prepareTab(env.app, started.service).render(container);
        await settleUi();
        expect(container.textContent).toContain('Чат уже начат');
        expect([...container.querySelectorAll('button')].some((node) => node.textContent === 'Разобрать')).toBe(false);
    });
});
