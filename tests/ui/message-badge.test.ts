// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { buildStDom, installUiEnv, rerenderMessage } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';

let env: UiTestEnv;
let ui: UiImpl;

const badgesOf = (index: number) =>
    document.querySelectorAll<HTMLElement>(`#chat .mes[mesid="${index}"] .maestro-badge`);

beforeEach(() => {
    buildStDom(3);
    env = installUiEnv('ru');
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
});

afterEach(() => ui.dispose());

describe('messageBadge()', () => {
    it('inserts a badge at the start of .mes_buttons', () => {
        ui.messageBadge(1, { id: 'qc', text: 'Ответ ушёл в английский' });
        const badge = badgesOf(1)[0];
        expect(badge?.parentElement?.classList.contains('mes_buttons')).toBe(true);
        expect(badge?.parentElement?.firstElementChild).toBe(badge);
        expect(badge?.querySelector('.maestro-badge-text')?.textContent).toBe('Ответ ушёл в английский');
        expect(badgesOf(0)).toHaveLength(0);
    });

    it('falls back to after .mes_text when the message has no buttons', () => {
        buildStDom(2, { withButtons: false });
        ui.messageBadge(0, { id: 'x', text: 'Заметка' });
        const badge = badgesOf(0)[0];
        expect(badge?.previousElementSibling?.classList.contains('mes_text')).toBe(true);
    });

    it('runs the action button without bubbling to the message', () => {
        const run = vi.fn();
        const messageClick = vi.fn();
        document.querySelector('#chat .mes[mesid="2"]')?.addEventListener('click', messageClick);
        ui.messageBadge(2, { id: 'redo', text: 'Брак', action: { label: 'Переделать', run } });
        const action = badgesOf(2)[0]?.querySelector<HTMLButtonElement>('.maestro-badge-action');
        expect(action?.textContent).toBe('Переделать');
        action?.click();
        expect(run).toHaveBeenCalledTimes(1);
        expect(messageClick).not.toHaveBeenCalled();
    });

    it('is idempotent per id and replaces the text of the same id', () => {
        ui.messageBadge(1, { id: 'a', text: 'one' });
        ui.messageBadge(1, { id: 'a', text: 'two' });
        ui.messageBadge(1, { id: 'b', text: 'three' });
        expect([...badgesOf(1)].map((node) => node.dataset.maestroBadge).sort()).toEqual(['a', 'b']);
        expect([...badgesOf(1)].find((node) => node.dataset.maestroBadge === 'a')?.textContent).toContain('two');
    });

    it('re-applies after ST re-renders the message', async () => {
        ui.messageBadge(1, { id: 'qc', text: 'Брак' });
        rerenderMessage(1);
        expect(badgesOf(1)).toHaveLength(0);
        await env.host.events.emit('MESSAGE_UPDATED', 1);
        expect(badgesOf(1)).toHaveLength(1);
        rerenderMessage(1);
        await env.host.events.emit('CHARACTER_MESSAGE_RENDERED', 1);
        expect(badgesOf(1)).toHaveLength(1);
    });

    it('applies when a lazily loaded message appears later', async () => {
        ui.messageBadge(5, { id: 'late', text: 'Позже' });
        expect(document.querySelectorAll('.maestro-badge')).toHaveLength(0);
        document
            .querySelector('#chat')
            ?.insertAdjacentHTML(
                'afterbegin',
                '<div class="mes" mesid="5"><div class="ch_name"><div class="mes_buttons"></div></div><div class="mes_text"></div></div>',
            );
        await env.host.events.emit('MORE_MESSAGES_LOADED');
        expect(badgesOf(5)).toHaveLength(1);
    });

    it('does not show a badge of another chat', async () => {
        ui.messageBadge(1, { id: 'qc', text: 'Брак' });
        env.mock.chatId = 'chat-2';
        rerenderMessage(1);
        await env.host.events.emit('CHAT_CHANGED', 'chat-2');
        expect(badgesOf(1)).toHaveLength(0);
        env.mock.chatId = 'chat-1';
        await env.host.events.emit('CHAT_CHANGED', 'chat-1');
        expect(badgesOf(1)).toHaveLength(1);
    });

    it('removes the badge through the remover and on dispose; stops re-applying', async () => {
        const off = ui.messageBadge(0, { id: 'a', text: 'A' });
        ui.messageBadge(1, { id: 'b', text: 'B' });
        off();
        expect(badgesOf(0)).toHaveLength(0);
        ui.dispose();
        expect(document.querySelectorAll('.maestro-badge')).toHaveLength(0);
        rerenderMessage(1);
        await env.host.events.emit('MESSAGE_UPDATED', 1);
        expect(document.querySelectorAll('.maestro-badge')).toHaveLength(0);
        expect(env.mock.eventSource.events.get('message_updated') ?? []).toHaveLength(0);
    });
});
