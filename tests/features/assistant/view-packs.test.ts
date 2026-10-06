// @vitest-environment happy-dom
// The assistant's tab with packs, the scope switch and attached context (M33, plan-2 §1): a pack card lists its changes
// with a tick each, «Применить выбранные» sends the kept ones, «Где действует» picks the scope, the composer shows the
// attached block as a removable chip and the sent message keeps it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApplyChoice, ToolSpec } from '../../../src/features/assistant/api';
import type { AssistantService } from '../../../src/features/assistant/service';
import { assistantTab } from '../../../src/features/assistant/view';
import { answer, callOf, calls, createAssistantEnv, flush, until } from './env';
import type { AssistantTestEnv } from './env';

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
    if (!found) throw new Error(`no button "${text}"`);
    return found;
}

const SCOPES = [
    { value: 'global', label: 'Везде' },
    { value: 'chat', label: 'Этот чат' },
];

function cardTool(name: string, items: number, chosen: (ApplyChoice | undefined)[]): ToolSpec {
    return {
        name,
        kind: 'write',
        description: `Test card ${name}.`,
        parameters: { type: 'object', properties: {} },
        async plan() {
            return {
                summary: items ? 'Почистить пресет' : 'Блок «Style»: текст',
                target: 'Пресет «Marinara» · твой слой',
                before: items ? undefined : { Текст: 'Write vividly.' },
                after: items ? undefined : { Текст: 'Write plainly.' },
                items: items
                    ? Array.from({ length: items }, (_, index) => ({
                          id: `c${index + 1}`,
                          summary: `Правка ${index + 1}`,
                          before: { Состояние: 'включён' },
                          after: { Состояние: 'выключен' },
                      }))
                    : undefined,
                scope: 'global',
                scopes: SCOPES,
                async apply(choice) {
                    chosen.push(choice);
                    return {};
                },
            };
        },
    };
}

describe('M33 tab: packs, scopes and attached context', () => {
    let env: AssistantTestEnv;
    let service: AssistantService;
    let container: HTMLElement;
    let dispose: (() => void) | void;
    const chosen: (ApplyChoice | undefined)[] = [];

    beforeEach(() => {
        chosen.length = 0;
        env = createAssistantEnv({ locale: 'ru' });
        service = env.service();
        service.start();
        service.registerTool(cardTool('pack_thing', 3, chosen));
        service.registerTool(cardTool('single_thing', 0, chosen));
        container = document.createElement('div');
        document.body.append(container);
        dispose = assistantTab(env.app, service).render(container);
    });

    afterEach(() => {
        if (typeof dispose === 'function') dispose();
        container.remove();
    });

    it('shows a pack with a tick per change and applies the kept ones', async () => {
        env.llm.script(calls(callOf('pack_thing', {}, 'p1')), answer('Готово.'));
        const sending = service.send('Почисти пресет');
        await until(() => !!container.querySelector('.maestro-m33-pack .maestro-m33-item-tick'));
        const card = container.querySelector('.maestro-m33-pack') as HTMLElement;
        expect(card.querySelector('.maestro-m33-pack-badge')?.textContent).toBe('Пакет: 3 правки');
        expect([...card.querySelectorAll('.maestro-m33-item-summary')].map((node) => node.textContent)).toEqual([
            'Правка 1',
            'Правка 2',
            'Правка 3',
        ]);
        expect(card.querySelectorAll('.maestro-m33-item details[open]')).toHaveLength(3);
        const some = buttonByText(card, 'Применить выбранные');
        expect(some.disabled).toBe(true);
        const ticks = [...card.querySelectorAll<HTMLInputElement>('.maestro-m33-item-tick')];
        ticks[1]!.checked = false;
        ticks[1]!.dispatchEvent(new Event('change'));
        expect(some.disabled).toBe(false);
        expect(card.querySelectorAll('.maestro-m33-item-off')).toHaveLength(1);
        const select = card.querySelector('.maestro-m33-card-scope select') as HTMLSelectElement;
        select.value = 'chat';
        select.dispatchEvent(new Event('change'));
        some.click();
        await sending;
        await flush();
        expect(chosen).toEqual([{ selected: ['c1', 'c3'], scope: 'chat' }]);
        const done = container.querySelector('.maestro-m33-pack') as HTMLElement;
        expect(done.querySelector('.maestro-m33-item-tick')).toBeNull();
        expect([...done.querySelectorAll('.maestro-m33-item-state')].map((node) => node.textContent)).toEqual([
            'применено',
            'не применялось',
            'применено',
        ]);
        expect(done.textContent).toContain('Применено 2 из 3. Откатить можно в журнале.');
        expect(done.querySelector('.maestro-m33-card-scope')?.textContent).toBe('Где действует: Этот чат');
    });

    it('applies a whole pack with «Применить всё»', async () => {
        env.llm.script(calls(callOf('pack_thing', {}, 'p1')), answer('Готово.'));
        const sending = service.send('Почисти');
        await until(() => !!container.querySelector('.maestro-m33-pack .maestro-m33-apply'));
        buttonByText(container, 'Применить всё').click();
        await sending;
        expect(chosen).toEqual([{ selected: ['c1', 'c2', 'c3'], scope: 'global' }]);
    });

    it('sends the scope picked on a single card', async () => {
        env.llm.script(calls(callOf('single_thing', {}, 's1')), answer('Готово.'));
        const sending = service.send('Поправь стиль');
        await until(() => !!container.querySelector('.maestro-m33-card-scope select'));
        const card = container.querySelector('.maestro-m33-card') as HTMLElement;
        expect(card.querySelector('.maestro-diff')?.textContent).toContain('Write');
        const select = card.querySelector('.maestro-m33-card-scope select') as HTMLSelectElement;
        expect([...select.options].map((option) => option.textContent)).toEqual(['Везде', 'Этот чат']);
        select.value = 'chat';
        select.dispatchEvent(new Event('change'));
        buttonByText(card, 'Применить').click();
        await sending;
        expect(chosen).toEqual([{ scope: 'chat' }]);
    });

    it('shows the attached block as a chip; ✕ removes it; the sent message keeps it', async () => {
        const attached = () => container.querySelector('.maestro-m33-attached') as HTMLElement;
        expect(attached().hidden).toBe(true);
        service.attach({ kind: 'presetBlock', preset: 'Marinara', identifier: 'main', label: 'Main Prompt' });
        service.attach({ kind: 'preset', preset: 'Marinara', label: 'Marinara' });
        expect(attached().hidden).toBe(false);
        expect([...attached().querySelectorAll('.maestro-m33-context')].map((node) => node.textContent)).toEqual([
            'Блок «Main Prompt» из «Marinara»',
            'Пресет «Marinara»',
        ]);
        (attached().querySelectorAll('.maestro-m33-context-remove')[1] as HTMLButtonElement).click();
        expect(attached().querySelectorAll('.maestro-m33-context')).toHaveLength(1);
        env.llm.script(answer('Смотрю блок.'));
        const input = container.querySelector('textarea.maestro-m33-input') as HTMLTextAreaElement;
        input.value = 'Сократи его';
        buttonByText(container, 'Отправить').click();
        await until(() => !service.busy() && service.conversation().length === 2);
        expect(attached().hidden).toBe(true);
        const bubble = container.querySelector('.maestro-m33-user') as HTMLElement;
        expect(bubble.querySelector('.maestro-m33-context')?.textContent).toBe('Блок «Main Prompt» из «Marinara»');
        expect(bubble.querySelector('.maestro-m33-context-remove')).toBeNull();
    });
});
