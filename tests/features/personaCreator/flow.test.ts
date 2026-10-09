// @vitest-environment happy-dom
// M41's window, stage by stage: the form (comment and checkboxes; without NAI Studio's persona keys the passport and
// the picture are off with a note), the model as a stoppable job, the review (edits; the «Гардероб» line follows the
// outfits; «Ещё раз» asks for another character), the creation with its steps, the result with «Сделать текущей» and
// «Открыть персоны»; a hidden window comes back from the job's notice; closing while the model works stops it.
import { afterEach, describe, expect, it } from 'vitest';
import { PersonaCreator, PersonaUi, StPersonas, personaJobKey } from '../../../src/features/personaCreator';
import { readPersonaCreatorSettings } from '../../../src/features/personaCreator/settings';
import type { PersonaCreatorSettings } from '../../../src/features/personaCreator/settings';
import { installFakeNaiPersona, removeFakeNaiPersona } from '../../helpers/nai-persona';
import { createEnv, flush } from './helpers';
import type { Env } from './helpers';

afterEach(() => {
    removeFakeNaiPersona();
    document.body.innerHTML = '';
});

const CARD = { index: 0, avatar: 'vera.png', name: 'Вера' };

function setup(env: Env) {
    const settings = () =>
        readPersonaCreatorSettings(env.settings.module<Partial<PersonaCreatorSettings>>('personaCreator'));
    const service = new PersonaCreator(env.app, env.app.log, new StPersonas(env.app, env.app.log), settings);
    const ui = new PersonaUi(env.app, env.app.log, service, settings, env.opener);
    return { ui, service };
}

function body(env: Env): HTMLElement {
    const dialog = env.dialogs.at(-1);
    if (!dialog?.handle.open) throw new Error('no window');
    return dialog.handle.body;
}

function click(env: Env, action: string): void {
    const node = body(env).querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (!node) throw new Error(`no button ${action}`);
    node.click();
}

function type(node: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    node.value = value;
    node.dispatchEvent(new Event('input'));
}

function option(env: Env, name: string): HTMLInputElement {
    return body(env).querySelector<HTMLInputElement>(`input[data-option="${name}"]`)!;
}

describe('the persona window', () => {
    it('goes from the comment to the review, the creation and the result', async () => {
        const env = createEnv();
        installFakeNaiPersona();
        const { ui } = setup(env);
        ui.open(CARD);
        expect(ui.stage()).toBe('form');
        expect(body(env).querySelector('h3')?.textContent).toBe('Персона для «Вера»');
        const comment = body(env).querySelector<HTMLTextAreaElement>('textarea[data-field="comment"]')!;
        expect(comment.placeholder).toBe('Например: наёмница с севера, давно знает Веру');
        expect([option(env, 'passport').checked, option(env, 'picture').checked, option(env, 'link').checked]).toEqual([
            true,
            true,
            true,
        ]);
        expect(option(env, 'makeCurrent').checked).toBe(false);
        type(comment, 'наёмница с севера');
        option(env, 'link').click();

        click(env, 'think');
        expect(ui.stage()).toBe('thinking');
        expect(ui.isBusy('vera.png')).toBe(true);
        await flush();
        expect(ui.stage()).toBe('review');
        expect(env.llm.requests[0]!.messages[1]!.content).toContain('наёмница с севера');
        expect(env.app.jobs!.get(personaJobKey(CARD))?.summary).toBe('придумал «Мира»');

        const name = body(env).querySelector<HTMLInputElement>('input[data-field="name"]')!;
        const description = body(env).querySelector<HTMLTextAreaElement>('textarea[data-field="description"]')!;
        expect(name.value).toBe('Мира');
        expect(description.value).toContain('Внешность: Высокая худая женщина');
        expect(description.value).toContain('Гардероб: Повседневный, Домашний, Парадный, Рабочий, Дорожный, Ночной.');
        expect(body(env).querySelectorAll('.maestro-m41-outfit')).toHaveLength(6);
        expect(body(env).textContent).toContain('Прочитано записей лора: 4 из 4');

        // Outfit edits follow into the «Гардероб» line; a removed outfit leaves it.
        type(body(env).querySelector<HTMLInputElement>('input[data-field="outfit-name"]')!, 'Будничный');
        expect(description.value).toContain('Гардероб: Будничный, Домашний');
        body(env).querySelectorAll<HTMLButtonElement>('[data-action="remove-outfit"]')[5]!.click();
        expect(body(env).querySelectorAll('.maestro-m41-outfit')).toHaveLength(5);
        const text = body(env).querySelector<HTMLTextAreaElement>('textarea[data-field="description"]')!;
        expect(text.value).toContain('Гардероб: Будничный, Домашний, Парадный, Рабочий, Дорожный.');
        type(body(env).querySelector<HTMLInputElement>('input[data-field="name"]')!, 'Мирослава');

        click(env, 'create');
        expect(ui.stage()).toBe('creating');
        await flush();
        expect(ui.stage()).toBe('done');
        expect(ui.isBusy()).toBe(false);
        const avatarId = env.personas.initPersona.mock.calls[0]![0] as string;
        expect(avatarId).toMatch(/^\d+-Miroslava\.png$/);
        expect(env.personas.initPersona.mock.calls[0]!.slice(1)).toEqual([
            'Мирослава',
            expect.stringContaining('Гардероб: Будничный, Домашний, Парадный, Рабочий, Дорожный.'),
            'наёмница с севера',
        ]);
        // «Связать» was unchecked: no link, and the step is not listed.
        expect((env.power.persona_descriptions as Record<string, Record<string, unknown>>)[avatarId]?.connections).toBe(
            undefined,
        );
        expect(body(env).querySelector('[data-step="link"]')).toBeNull();
        expect(body(env).querySelector('h3')?.textContent).toBe('Персона «Мирослава» готова');
        expect(body(env).querySelector('[data-step="passport"]')?.textContent).toContain('5 нарядов');
        expect(body(env).querySelector<HTMLImageElement>('.maestro-m41-preview')?.src).toContain(
            encodeURIComponent(avatarId),
        );
        expect(body(env).textContent).toContain('Отмены нет');
        // The choices are remembered, «Сделать текущей» is not.
        expect(env.settings.module<PersonaCreatorSettings>('personaCreator').link).toBe(false);
        expect(env.app.jobs!.get(personaJobKey(CARD))?.summary).toBe(
            '«Мирослава»: персона, паспорт (5 нарядов), картинка',
        );

        click(env, 'makeCurrent');
        await flush();
        expect(env.personas.setUserAvatar).toHaveBeenCalledWith(avatarId, { toastPersonaNameChange: false });
        const current = body(env).querySelector<HTMLButtonElement>('[data-action="makeCurrent"]')!;
        expect(current.disabled).toBe(true);
        expect(current.textContent).toBe('Текущая');

        click(env, 'openPersonas');
        await flush();
        expect(ui.stage()).toBeNull();
        expect(env.personas.getUserAvatars).toHaveBeenLastCalledWith(true, avatarId);
    });

    it('turns the passport and the picture off with a note without NAI Studio’s persona keys', async () => {
        const env = createEnv();
        installFakeNaiPersona({ personaKeys: false });
        const { ui } = setup(env);
        ui.open(CARD);
        expect(option(env, 'passport').disabled).toBe(true);
        expect(option(env, 'passport').checked).toBe(false);
        expect(option(env, 'picture').disabled).toBe(true);
        expect(body(env).querySelector('.maestro-m41-note')?.textContent).toBe(
            'Для паспорта и картинки нужна свежая NAI Studio (паспорта для любой персоны).',
        );
        click(env, 'think');
        await flush();
        click(env, 'create');
        await flush();
        expect(body(env).querySelector('[data-step="passport"]')?.textContent).toContain('нужна свежая NAI Studio');
        expect(body(env).querySelector('[data-step="picture"]')?.textContent).toContain('нужна свежая NAI Studio');
        expect(env.app.jobs!.get(personaJobKey(CARD))?.summary).toBe(
            '«Мира»: персона, связь с персонажем, без паспорта (нужна свежая NAI Studio)',
        );
    });

    it('the picture follows the passport checkbox', () => {
        const env = createEnv();
        installFakeNaiPersona();
        const { ui } = setup(env);
        ui.open(CARD);
        option(env, 'passport').click();
        expect(option(env, 'picture').disabled).toBe(true);
        expect(option(env, 'picture').checked).toBe(false);
        option(env, 'passport').click();
        expect(option(env, 'picture').disabled).toBe(false);
        expect(option(env, 'picture').checked).toBe(true);
    });

    it('«Ещё раз» asks for a different character with the changed comment', async () => {
        const env = createEnv();
        const { ui } = setup(env);
        ui.open(CARD);
        click(env, 'think');
        await flush();
        type(body(env).querySelector<HTMLTextAreaElement>('textarea[data-field="comment"]')!, 'лучше маг');
        click(env, 'again');
        await flush();
        expect(ui.stage()).toBe('review');
        const second = env.llm.requests[1]!.messages[1]!.content;
        expect(second).toContain('<player_comment>\nлучше маг\n</player_comment>');
        expect(second).toContain('Earlier attempts were: Мира.');
    });

    it('shows a failed answer and lets the user try again', async () => {
        const env = createEnv();
        env.llm.answers = [{ ok: false, error: 'timeout' }];
        const { ui } = setup(env);
        ui.open(CARD);
        click(env, 'think');
        await flush();
        expect(ui.stage()).toBe('form');
        expect(body(env).querySelector('.maestro-m41-error')?.textContent).toBe('Модель не ответила: timeout');
        expect(env.app.jobs!.get(personaJobKey(CARD))?.state).toBe('failed');
    });

    it('stops the model when the window is closed', async () => {
        const env = createEnv();
        let release!: () => void;
        env.llm.wait = new Promise<void>((resolve) => (release = resolve));
        const { ui } = setup(env);
        ui.open(CARD, { comment: 'маг', autostart: true });
        await flush(2);
        expect(ui.stage()).toBe('thinking');
        env.dialogs.at(-1)!.userClose();
        expect(ui.stage()).toBeNull();
        release();
        await flush();
        expect(env.app.jobs!.get(personaJobKey(CARD))?.state).toBe('cancelled');
        expect(env.llm.requests[0]!.signal?.aborted).toBe(true);
        expect(env.ui.notices).toEqual([]);
    });

    it('a hidden creation reports its end with «Показать», which brings the result back', async () => {
        const env = createEnv();
        installFakeNaiPersona();
        const { ui } = setup(env);
        ui.open(CARD);
        click(env, 'think');
        await flush();
        click(env, 'create');
        click(env, 'hide');
        expect(env.dialogs.at(-1)!.handle.open).toBe(false);
        expect(ui.isBusy('vera.png')).toBe(true);
        await flush();
        expect(ui.stage()).toBe('done');
        const notice = env.ui.notices.at(-1)!;
        expect(notice.text).toBe(
            'Персона для «Вера»: «Мира»: персона, связь с персонажем, паспорт (6 нарядов), картинка',
        );
        expect(notice.options?.action?.label).toBe('Показать');
        notice.options!.action!.run();
        expect(body(env).querySelector('h3')?.textContent).toBe('Персона «Мира» готова');
        click(env, 'done');
        expect(ui.stage()).toBeNull();
    });

    it('one flow at a time: another card waits while one is busy', async () => {
        const env = createEnv();
        let release!: () => void;
        env.llm.wait = new Promise<void>((resolve) => (release = resolve));
        const { ui } = setup(env);
        ui.open(CARD, { comment: 'маг', autostart: true });
        await flush(2);
        ui.open({ index: 1, avatar: 'martin.png', name: 'Мартин' });
        expect(env.ui.notices.at(-1)?.text).toBe('Уже создаю персону для «Вера»');
        release();
        await flush();
        expect(ui.stage()).toBe('review');
        ui.open({ index: 1, avatar: 'martin.png', name: 'Мартин' });
        expect(ui.stage()).toBe('form');
        expect(body(env).querySelector('h3')?.textContent).toBe('Персона для «Мартин»');
        ui.dispose();
        expect(ui.stage()).toBeNull();
    });

    it('says when there is no profile for the task', () => {
        const env = createEnv();
        env.llm.available = false;
        const { ui } = setup(env);
        ui.open(CARD);
        expect(body(env).querySelector<HTMLButtonElement>('[data-action="think"]')!.disabled).toBe(true);
        expect(body(env).querySelector('.maestro-m41-error')?.textContent).toContain('Нет профиля подключения');
    });
});
