// @vitest-environment happy-dom
// M41's entry points in ST's character editor: the «Создать персону» button right after «Connected Personas» and the
// «More…» option, shown only for one existing character (not the create form, not a group), put back when ST opens the
// editor again, pressed by click or by the dropdown event; everything goes when the module stops. The slash command
// opens the window for the chat's character.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorButton, M41_NODES, personaCreatorModule } from '../../../src/features/personaCreator';
import { personaCommand } from '../../../src/features/personaCreator';
import type { CardRef } from '../../../src/features/personaCreator';
import type { SlashCommandSpec, Unsubscribe } from '../../../src/shared/contracts';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { createEnv, flush, installEditor } from './helpers';
import type { Env } from './helpers';

afterEach(() => {
    document.body.innerHTML = '';
});

const EDITOR_OPENED = 'character_editor_opened';
const DROPDOWN = 'charManagementDropdown';

function button(): HTMLElement | null {
    return document.getElementById(M41_NODES.button);
}

function option(): HTMLOptionElement | null {
    return document.getElementById(M41_NODES.option) as HTMLOptionElement | null;
}

function editorButton(env: Env, busy = () => false) {
    const pressed: CardRef[] = [];
    const ui = new EditorButton(env.app, env.app.log, (card) => pressed.push(card), busy);
    return { ui, pressed };
}

describe('the editor button', () => {
    it('sits right after «Connected Personas», with an option in «More…»', () => {
        const env = createEnv();
        installEditor();
        const { ui } = editorButton(env);
        ui.install();
        const node = button();
        expect(node).not.toBeNull();
        expect(node!.previousElementSibling?.id).toBe('char_connections_button');
        expect(node!.nextElementSibling?.id).toBe('export_button');
        expect(node!.classList.contains('fa-user-plus')).toBe(true);
        expect(node!.title).toBe('Создать персону игрока для этого персонажа');
        expect(node!.style.display).toBe('');
        expect(option()?.textContent).toBe('Создать персону');
        expect(option()?.hidden).toBe(false);
        ui.ensure();
        expect(document.querySelectorAll(`#${M41_NODES.button}`)).toHaveLength(1);
        expect(document.querySelectorAll(`#${M41_NODES.option}`)).toHaveLength(1);
    });

    it('opens for the card the editor holds, by click and by the dropdown', async () => {
        const env = createEnv();
        installEditor('martin.png');
        const { ui, pressed } = editorButton(env);
        ui.install();
        button()!.click();
        await env.mock.eventSource.emit(DROPDOWN, M41_NODES.option);
        await env.mock.eventSource.emit(DROPDOWN, 'renameCharButton');
        expect(pressed).toEqual([
            { index: 1, avatar: 'martin.png', name: 'Мартин' },
            { index: 1, avatar: 'martin.png', name: 'Мартин' },
        ]);
    });

    it('hides on the create form and in a group, and shows again', async () => {
        const env = createEnv();
        const form = installEditor();
        const { ui, pressed } = editorButton(env);
        ui.install();
        form.setAttribute('actiontype', 'createcharacter');
        await flush(2);
        expect(button()!.style.display).toBe('none');
        expect(option()!.hidden).toBe(true);
        expect(option()!.disabled).toBe(true);
        await env.mock.eventSource.emit(DROPDOWN, M41_NODES.option);
        expect(pressed).toEqual([]);
        expect(env.ui.notices.at(-1)?.text).toBe('Открой карточку одного персонажа (не группы)');
        form.setAttribute('actiontype', 'editcharacter');
        await flush(2);
        expect(button()!.style.display).toBe('');
        Object.assign(env.mock.context, { groupId: 'g1' });
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!);
        expect(button()!.style.display).toBe('none');
    });

    it('comes back when ST rebuilds the editor, and marks a busy card', async () => {
        const env = createEnv();
        installEditor();
        let busy = false;
        const { ui } = editorButton(env, () => busy);
        ui.install();
        installEditor();
        expect(button()).toBeNull();
        busy = true;
        await env.mock.eventSource.emit(EDITOR_OPENED, '0');
        expect(button()).not.toBeNull();
        expect(button()!.classList.contains(M41_NODES.busy)).toBe(true);
        busy = false;
        ui.update();
        expect(button()!.classList.contains(M41_NODES.busy)).toBe(false);
    });

    it('falls back to the id of CHARACTER_EDITOR_OPENED without the avatar field', async () => {
        const env = createEnv();
        installEditor();
        document.getElementById('avatar_url_pole')!.remove();
        Object.assign(env.mock.context, { characterId: undefined });
        const { ui, pressed } = editorButton(env);
        ui.install();
        expect(button()!.style.display).toBe('none');
        await env.mock.eventSource.emit(EDITOR_OPENED, 1);
        button()!.click();
        expect(pressed.map((card) => card.name)).toEqual(['Мартин']);
    });
});

describe('the module', () => {
    async function start(env: Env) {
        const offs: (Unsubscribe | (() => void | Promise<void>))[] = [];
        const commands: SlashCommandSpec[] = [];
        env.ui.addSlashCommand = (command) => {
            commands.push(command);
            return () => {};
        };
        await personaCreatorModule.init({
            app: env.app,
            settings: personaCreatorModule.defaults(),
            log: env.app.log,
            own: (off) => void offs.push(off),
        });
        return {
            commands,
            async stop() {
                for (const off of offs.splice(0).reverse()) await off();
            },
        };
    }

    it('installs the button on APP_READY and editor events and takes it back when it stops', async () => {
        const env = createEnv();
        const module = await start(env);
        expect(button()).toBeNull();
        installEditor();
        await env.mock.eventSource.emit(EVENT_TYPES.APP_READY!);
        expect(button()).not.toBeNull();
        expect(module.commands.map((command) => command.name)).toEqual(['maestro-persona']);
        expect(personaCreatorModule.requires).toEqual(['st.personas']);
        await module.stop();
        expect(button()).toBeNull();
        expect(option()).toBeNull();
        installEditor();
        await env.mock.eventSource.emit(EDITOR_OPENED, 0);
        expect(button()).toBeNull();
    });

    it('opens the window for the chat character from the slash command, at once with a comment', () => {
        const env = createEnv();
        const ui = { open: vi.fn() };
        const command = personaCommand(env.app, ui);
        expect(command.callback({}, '  наёмница с севера ')).toBe('');
        expect(command.callback({}, '')).toBe('');
        expect(ui.open.mock.calls).toEqual([
            [
                { index: 0, avatar: 'vera.png', name: 'Вера' },
                { comment: 'наёмница с севера', autostart: true },
            ],
            [
                { index: 0, avatar: 'vera.png', name: 'Вера' },
                { comment: '', autostart: false },
            ],
        ]);
        Object.assign(env.mock.context, { groupId: 'g1' });
        expect(command.callback({}, 'кто-то')).toBe('Открой чат с одним персонажем');
        expect(ui.open).toHaveBeenCalledTimes(2);
    });
});
