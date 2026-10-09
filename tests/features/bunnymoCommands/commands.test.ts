// @vitest-environment happy-dom
// M40 «Команды BunnyMo»: the group of the Maestro button at the message box — hidden without the BunnyMo core, the six
// sheet commands with hints (a warning while M31 «Листы» is off), targets from the scene (DES tracker of the committed
// reply), «Другой…» and «Запомнить момент» through Ui.prompt, inserting into the message box versus sending at once
// with /send | /trigger, «Словарь BunnyMo» and «Досье персонажа».
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import { bunnymoCommandsModule } from '../../../src/features/bunnymoCommands';
import type { BunnyMoCommands } from '../../../src/features/bunnymoCommands';
import { BUNNYMO_COMMANDS_STRINGS } from '../../../src/features/bunnymoCommands/strings';
import type { App, ComposerGroup, ComposerItem, GenerationInfo, SettingsSection } from '../../../src/shared/contracts';
import { createTestHost, createTestLogger } from '../../helpers/core-host';
import { FakeModules } from '../../helpers/rules-app';
import { installStMock, message } from '../../helpers/st-mock';
import type { StMock } from '../../helpers/st-mock';

interface Env {
    app: App;
    mock: StMock;
    groups: ComposerGroup[];
    sections: SettingsSection[];
    notices: string[];
    prompts: string[];
    answers: (string | null)[];
    caps: Set<string>;
    enabled: Record<string, boolean>;
    slice: Record<string, unknown>;
    generation: { value: GenerationInfo | null };
    modules: FakeModules;
    commands: BunnyMoCommands;
}

function tracker(names: string[]): STChatMessage {
    return message('Ответ.', {
        swipe_id: 0,
        extra: {
            dooms_tracker_swipes: [
                {
                    quests: null,
                    infoBox: null,
                    characterThoughts: JSON.stringify(names.map((name) => ({ name, details: {} }))),
                },
            ],
        },
    });
}

async function createEnv(): Promise<Env> {
    document.body.innerHTML = '<textarea id="send_textarea"></textarea>';
    const mock = installStMock();
    mock.chatId = 'chat-1';
    mock.context.name1 = 'Алекс';
    mock.context.name2 = 'Вера';
    mock.chat = [
        message('Привет', { is_user: false }),
        tracker(['Офелия', 'Кай']),
        message('Дальше', { is_user: true }),
    ];
    (mock.context as unknown as { executeSlashCommandsWithOptions: unknown }).executeSlashCommandsWithOptions = vi.fn(
        async () => ({}),
    );
    const host = createTestHost(mock);
    const caps = new Set<string>(['bunnymo.core']);
    host.caps.has = (id: string) => caps.has(id);
    const i18n = createI18n(() => 'ru');
    i18n.register(CORE_STRINGS);
    i18n.register(BUNNYMO_COMMANDS_STRINGS);
    const modules = new FakeModules();
    const groups: ComposerGroup[] = [];
    const sections: SettingsSection[] = [];
    const notices: string[] = [];
    const prompts: string[] = [];
    const answers: (string | null)[] = [];
    const enabled: Record<string, boolean> = { sheets: true };
    const slice: Record<string, unknown> = {};
    const generation = { value: null as GenerationInfo | null };
    const app = {
        host,
        log: createTestLogger([]),
        i18n,
        turn: { current: () => generation.value },
        settings: {
            module: () => slice,
            isModuleEnabled: (key: string) => enabled[key] !== false,
            save() {},
            notify() {},
        },
        modules,
        adapters: { des: { removedCharacters: () => [] } },
        ui: {
            notice: (text: string) => notices.push(text),
            prompt: async (title: string) => {
                prompts.push(title);
                return answers.shift() ?? null;
            },
            addComposerAction: (group: ComposerGroup) => {
                groups.push(group);
                return () => groups.splice(groups.indexOf(group), 1);
            },
            addSettingsSection: (section: SettingsSection) => {
                sections.push(section);
                return () => {};
            },
        },
    } as unknown as App;
    await bunnymoCommandsModule.init({ app, settings: slice as never, log: app.log, own: () => {} });
    const commands = modules.api<BunnyMoCommands>('bunnymoCommands')!;
    return {
        app,
        mock,
        groups,
        sections,
        notices,
        prompts,
        answers,
        caps,
        enabled,
        slice,
        generation,
        modules,
        commands,
    };
}

const box = () => document.querySelector<HTMLTextAreaElement>('#send_textarea')!;
const item = (items: ComposerItem[], id: string) => items.find((entry) => entry.id === id)!;
const slashCalls = (env: Env) =>
    (env.mock.context as unknown as { executeSlashCommandsWithOptions: ReturnType<typeof vi.fn> })
        .executeSlashCommandsWithOptions.mock.calls;

let env: Env;

beforeEach(async () => {
    env = await createEnv();
});

describe('the BunnyMo group', () => {
    it('is shown only with the BunnyMo core in an open chat', () => {
        const group = env.groups[0]!;
        expect(group.label()).toBe('BunnyMo');
        expect(group.visible!()).toBe(true);
        env.caps.delete('bunnymo.core');
        expect(group.visible!()).toBe(false);
        env.caps.add('bunnymo.core');
        env.mock.chatId = undefined;
        expect(group.visible!()).toBe(false);
    });

    it('lists the six sheet commands with plain hints, and warns while «Листы» are off', () => {
        const items = env.groups[0]!.items();
        expect(items.map((entry) => entry.label)).toEqual([
            'Полный лист',
            'Короткий лист',
            'Только теги',
            'Обновить теги',
            'Внешность',
            'Запомнить момент',
        ]);
        expect(item(items, 'fullsheet').hint).toBe('психологический разбор персонажа, долго');
        env.enabled.sheets = false;
        expect(item(env.groups[0]!.items(), 'fullsheet').hint).toBe(
            'психологический разбор персонажа, долго · «Листы» Maestro выключены — лист займёт много контекста',
        );
    });

    it('offers the characters of the scene, the card’s character, the user and «Другой…»', () => {
        const targets = item(env.groups[0]!.items(), 'fullsheet').submenu!();
        expect(targets.map((entry) => entry.label)).toEqual(['Офелия', 'Кай', 'Вера', 'Алекс (ты)', 'Другой…']);
    });

    it('puts the command at the start of the message box and keeps the typed text', async () => {
        box().value = 'Как ты?';
        const input = vi.fn();
        box().addEventListener('input', input);
        await item(env.groups[0]!.items(), 'physheet').submenu!()[0]!.run!();
        expect(box().value).toBe('!physheet Офелия\nКак ты?');
        expect(input).toHaveBeenCalled();
        expect(document.activeElement).toBe(box());
        expect(slashCalls(env)).toHaveLength(0);
    });

    it('asks for another name and for the moment to remember', async () => {
        env.answers.push('Незнакомка');
        const other = item(env.groups[0]!.items(), 'tagsheet').submenu!().at(-1)!;
        await other.run!();
        expect(env.prompts).toEqual(['Для кого лист?']);
        expect(box().value).toBe('!tagsheet Незнакомка');
        env.answers.push('первый поцелуй на мосту');
        await item(env.groups[0]!.items(), 'memsheet').run!();
        expect(box().value).toBe('!memsheet первый поцелуй на мосту');
        // Cancelled: nothing changes.
        await item(env.groups[0]!.items(), 'memsheet').run!();
        expect(box().value).toBe('!memsheet первый поцелуй на мосту');
    });

    it('sends at once with «Отправлять сразу», so M31 sees a user message with the command', async () => {
        env.slice.sendNow = true;
        box().value = 'черновик';
        await item(env.groups[0]!.items(), 'fullsheet').submenu!()[1]!.run!();
        expect(slashCalls(env).at(-1)![0]).toBe('/send !fullsheet Кай | /trigger');
        expect(box().value).toBe('черновик');
        // While a reply is being written the command waits in the box.
        env.generation.value = { type: 'normal', dryRun: false, quiet: false };
        await item(env.groups[0]!.items(), 'quicksheet').submenu!()[0]!.run!();
        expect(slashCalls(env)).toHaveLength(1);
        expect(box().value).toBe('!quicksheet Офелия\nчерновик');
        expect(env.notices.at(-1)).toContain('Сейчас идёт ответ');
    });

    it('opens the BunnyMo dictionary and dossiers without a model', () => {
        const open = vi.fn();
        const openByName = vi.fn((name: string) => name !== 'Кай');
        env.modules.expose('bunnymoMode', { open });
        env.modules.expose('dossier', { openByName });
        const items = env.groups[0]!.items();
        void item(items, 'dictionary').run!();
        expect(open).toHaveBeenCalled();
        const people = item(items, 'dossier').submenu!();
        void people[0]!.run!();
        expect(openByName).toHaveBeenCalledWith('Офелия');
        void people[1]!.run!();
        expect(env.notices.at(-1)).toBe('Досье на Кай пока нет.');
    });

    it('has the «Отправлять сразу» setting in the Settings tab', () => {
        const container = document.createElement('div');
        env.sections[0]!.render(container);
        const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        expect(container.textContent).toContain('Отправлять сразу');
        expect(input.checked).toBe(false);
        input.checked = true;
        input.dispatchEvent(new Event('change'));
        expect(env.slice.sendNow).toBe(true);
    });
});
