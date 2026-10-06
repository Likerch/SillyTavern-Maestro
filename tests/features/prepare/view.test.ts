// @vitest-environment happy-dom
// The face of M37 over the real engine: the module registers a window of its own when the shell has windows (and the
// pult tab «Подготовка» when it has not), the offer under the greeting, and `/maestro-prepare` that opens the window
// first; the window reads the stand's card, shows the price, analyses through the mock LLM, applies the chosen items
// and shows the result in story words with «Готово к игре».
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareModule } from '../../../src/features/prepare';
import type { PrepareApi } from '../../../src/features/prepare/api';
import type { SlashCommandSpec, Unsubscribe } from '../../../src/shared/contracts';
import { createPrepareEnv } from './helpers';
import type { PrepareEnv } from './helpers';
import { buttonOf, card, hasButton, shellOf, tick, windowContext } from './ui-helpers';
import type { UiRecord } from './ui-helpers';

let env: PrepareEnv;
let shell: UiRecord;
let owned: (() => void | Promise<void>)[];
let command: SlashCommandSpec | null;
let container: HTMLElement;
let close: Unsubscribe | void;

async function startModule(options: { windows: boolean; strip?: boolean }): Promise<void> {
    env = createPrepareEnv();
    shell = shellOf(env, options);
    owned = [];
    command = null;
    env.ui.addSlashCommand = (spec) => {
        command = spec;
        return () => {};
    };
    await prepareModule.init({
        app: env.app,
        settings: prepareModule.defaults(),
        log: env.app.log,
        own: (off) => void owned.push(off),
    });
    await tick(60);
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
});

afterEach(async () => {
    if (typeof close === 'function') close();
    close = undefined;
    container.remove();
    for (const off of owned.splice(0).reverse()) await off();
});

function text(): string {
    return container.textContent ?? '';
}

async function settled(): Promise<void> {
    await tick();
    await tick();
}

describe('prepare: the module and the shell', () => {
    it('with windows: a window of its own (no pult tab), the strip line, «Открыть» leads to the window', async () => {
        await startModule({ windows: true });
        expect(shell.windows.map((spec) => [spec.id, spec.defaultDock, spec.defaultWidth])).toEqual([
            ['prepare', 'right', 640],
        ]);
        expect(shell.tabs).toEqual([]);
        expect(shell.strips.map((provider) => provider.id)).toEqual(['prepare']);
        expect(shell.strips[0]!.items(0)[0]?.text).toContain('Подготовить историю к игре?');
        // The slash command without a word opens the window first (the price before the run).
        const answer = await command!.callback({}, '');
        expect(answer).toContain('Открыл окно подготовки');
        expect(shell.opened).toEqual([{ id: 'prepare', options: undefined }]);
        expect(env.llm.requests).toEqual([]);
        for (const off of owned.splice(0).reverse()) await off();
        expect(shell.windows).toEqual([]);
        expect(shell.strips).toEqual([]);
    });

    it('without windows: the pult tab «Подготовка» with the same body; «Открыть» leads to the tab', async () => {
        await startModule({ windows: false, strip: false });
        expect(shell.windows).toEqual([]);
        expect(shell.tabs.map((tab) => [tab.id, tab.titleKey, tab.group])).toEqual([['prepare', 'm37.tab', 'world']]);
        close = shell.tabs[0]!.render(container);
        await settled();
        expect(text()).toContain('1. Что читать');
        expect(text()).toContain('Описание карточки');
        // `start` analyses right away; the job's «Открыть» opens the tab.
        const answer = await command!.callback({}, 'start');
        expect(answer).toContain('Персонажи (');
        const job = env.app.jobs!.list()[0]!;
        expect(env.app.jobs!.open(job.key)).toBe(true);
        expect(shell.pult).toEqual(['prepare']);
        expect(env.modules.api<PrepareApi>('prepare')!.state().stage).toBe('ready');
    });
});

describe('prepare: the window over the real engine', () => {
    it('estimates, analyses, applies the chosen items and shows what is ready', async () => {
        await startModule({ windows: true });
        const spec = shell.windows[0]!;
        close = spec.render!(container, windowContext());
        await settled();
        expect(text()).toMatch(/≈ .+, 2 части/);
        expect(text()).toContain('Описание карточки');
        expect(text()).toContain('Твоя персона');
        buttonOf(container, 'Начать').click();
        const api = env.modules.api<PrepareApi>('prepare')!;
        await api.whenDone();
        await settled();
        expect(text()).toContain('3. Просмотр');
        expect(text()).toContain('Персонажи (');
        expect(card(container, 'character:elizabet').textContent).toContain('Элизабет');
        buttonOf(container, 'Применить выбранное').click();
        await settled();
        await settled();
        expect(text()).toContain('4. Итог');
        expect(text()).toContain('Элизабет: в канон, паспорт');
        expect(hasButton(container, 'Отменить')).toBe(true);
        expect(text()).toContain('Готово к игре');
        expect(text()).not.toContain('Подготовка ещё не применена');
        // The offer is gone: the plan is applied.
        expect(shell.strips[0]!.items(0)).toEqual([]);
        buttonOf(container, 'К плану').click();
        await settled();
        expect(card(container, 'character:elizabet').textContent).toContain('уже в каноне');
    });

    it('says why a started chat is not prepared', async () => {
        await startModule({ windows: true });
        env.mock.chat.push({ ...env.mock.chat[0]!, is_user: true });
        close = shell.windows[0]!.render!(container, windowContext());
        await settled();
        expect(text()).toContain('Чат уже начат');
        expect(hasButton(container, 'Начать')).toBe(false);
    });
});
