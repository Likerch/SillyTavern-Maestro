// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { resetSlashSlots } from '../../src/ui/views/slash-commands';
import { buildStDom, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';

let env: UiTestEnv;
let ui: UiImpl;

beforeEach(() => {
    resetSlashSlots();
    buildStDom();
    env = installUiEnv('ru');
    env.i18n.register({
        en: { 'test.help': 'Help', 'test.arg.mode': 'Mode', 'test.arg.value': 'Text' },
        ru: { 'test.help': 'Справка', 'test.arg.mode': 'Режим', 'test.arg.value': 'Текст' },
    });
    ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
});

afterEach(() => ui.dispose());

function spec(
    callback = vi.fn(async (args: Record<string, unknown>, value: string) => `${String(args.mode ?? '')}|${value}`),
) {
    return {
        name: 'maestro-mode',
        helpKey: 'test.help',
        callback,
        args: [
            { name: 'mode', descriptionKey: 'test.arg.mode', optional: true },
            { name: 'value', descriptionKey: 'test.arg.value' },
        ],
    };
}

describe('addSlashCommand()', () => {
    it('registers through SlashCommandParser with localized help and argument lists', () => {
        ui.addSlashCommand(spec());
        expect(env.addCommandObject).toHaveBeenCalledTimes(1);
        const command = env.slashCommands['maestro-mode'];
        expect(command?.helpString).toBe('Справка');
        expect(command?.namedArgumentList).toEqual([
            { kind: 'named', name: 'mode', description: 'Режим', typeList: ['string'], isRequired: false },
        ]);
        expect(command?.unnamedArgumentList).toEqual([
            { kind: 'unnamed', description: 'Текст', typeList: ['string'], isRequired: true },
        ]);
    });

    it('passes named arguments (without ST service keys) and the unnamed text to the callback', async () => {
        const callback = vi.fn(async (args: Record<string, unknown>, value: string) => `${String(args.mode)}|${value}`);
        ui.addSlashCommand(spec(callback));
        const result = await env.slashCommands['maestro-mode']?.callback(
            { mode: 'cinema', _scope: {}, _abortController: {} },
            'go now',
        );
        expect(result).toBe('cinema|go now');
        expect(callback.mock.calls[0]?.[0]).toEqual({ mode: 'cinema' });
    });

    it('answers "module is off" after its remover and resumes after re-adding, without a second ST registration', async () => {
        const off = ui.addSlashCommand(spec());
        off();
        await expect(env.slashCommands['maestro-mode']?.callback({}, '')).resolves.toBe(
            '/maestro-mode сейчас не работает: выключен её модуль Maestro.',
        );
        ui.addSlashCommand(spec());
        expect(env.addCommandObject).toHaveBeenCalledTimes(1);
        await expect(env.slashCommands['maestro-mode']?.callback({ mode: 'x' }, 'y')).resolves.toBe('x|y');
    });

    it('answers "Maestro is disabled" after dispose, even for a later UI instance in the same page', async () => {
        ui.addSlashCommand(spec());
        ui.dispose();
        await expect(env.slashCommands['maestro-mode']?.callback({}, '')).resolves.toBe('Maestro отключён.');
        ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
        ui.addSlashCommand(spec());
        expect(env.addCommandObject).toHaveBeenCalledTimes(1);
        await expect(env.slashCommands['maestro-mode']?.callback({ mode: 'a' }, 'b')).resolves.toBe('a|b');
    });

    it('reports callback errors as text', async () => {
        ui.addSlashCommand(
            spec(
                vi.fn(async () => {
                    throw new Error('нет чата');
                }),
            ),
        );
        await expect(env.slashCommands['maestro-mode']?.callback({}, '')).resolves.toBe(
            '/maestro-mode: ошибка — нет чата',
        );
    });
});
