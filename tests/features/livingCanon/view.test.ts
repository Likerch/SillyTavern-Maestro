// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { livingCanonModule } from '../../../src/features/livingCanon';
import type { LivingCanonService } from '../../../src/features/livingCanon';
import {
    canonItem,
    contradiction,
    createLivingTestApp,
    flush,
    replyArrives,
    settle,
    startModule,
    turn,
} from './helpers';
import type { LivingTestApp } from './helpers';

const FESTIVAL =
    'Вечером начинался Праздник Фонарей — каждый год жители запускают бумажные фонари над рекой. Элдрин улыбнулся.';

let env: LivingTestApp;
let living: LivingCanonService;
let stop: () => Promise<void>;
let container: HTMLElement;
let unmount: (() => void) | void;

/** Redraws are coalesced (50 ms). */
const redraw = () => settle(90);

function render(): void {
    unmount = env.ui.tabs.find((tab) => tab.id === 'living')!.render(container);
}

function buttonByText(text: string, root: ParentNode = container): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === text,
    );
    if (!found) throw new Error(`no button ${text}`);
    return found;
}

function sections(): string[] {
    return [...container.querySelectorAll('.maestro-section-title')].map((node) => node.textContent ?? '');
}

beforeEach(async () => {
    env = createLivingTestApp();
    env.world.add('Элдрин');
    const started = await startModule(env, livingCanonModule);
    living = started.living;
    stop = () => started.stop();
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    await stop();
});

describe('M26 pult tab', () => {
    it('shows drafts, then the provisional fact with its quote, source and buttons', async () => {
        render();
        expect(sections()).toEqual(['Living canon', 'Provisional (0)', 'Confirmed recently (0)']);
        expect(container.textContent).toContain('No extraction yet.');
        await replyArrives(env, living, FESTIVAL);
        await redraw();
        expect(sections()).toContain('In the last reply (1)');
        expect(container.querySelector('.maestro-m26-draft .maestro-m26-name')?.textContent).toBe('Праздник Фонарей');
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        env.mock.chat.push({ ...env.mock.chat[0]!, is_user: true, mes: 'ok', send_date: 'u' });
        await flush(living);
        await redraw();
        expect(sections()).toContain('Provisional (1)');
        const fact = container.querySelector('.maestro-m26-fact')!;
        expect(fact.querySelector('.maestro-m26-quote')?.textContent).toContain('каждый год жители');
        expect(fact.textContent).toContain('turns without contradictions: 0 of 10');
        expect(fact.textContent).toContain('message #0');
        expect(fact.textContent).toContain('The English text comes with the next extraction.');
        expect(env.ui.tabs[0]?.badge?.()).toBe(1);
    });

    it('confirms and drops from the buttons', async () => {
        await turn(env, living, `${FESTIVAL} Там же чтили Орден Серебряной Луны — его основали века назад.`);
        render();
        const [first] = container.querySelectorAll('.maestro-m26-fact');
        buttonByText('Confirm', first!).click();
        await flush(living);
        await redraw();
        expect(sections()).toEqual(['Living canon', 'Provisional (1)', 'Confirmed recently (1)']);
        expect(container.textContent).toContain('you confirmed it');
        buttonByText('Drop').click();
        await flush(living);
        await redraw();
        expect(sections()).toContain('Provisional (0)');
        expect(env.canon.living()).toHaveLength(1);
    });

    it('confirms all provisional facts and reports the result', async () => {
        await turn(env, living, `${FESTIVAL} Там же чтили Орден Серебряной Луны — его основали века назад.`);
        render();
        buttonByText('Confirm all provisional').click();
        await flush(living);
        await redraw();
        expect(env.ui.notices.at(-1)?.text).toBe('Confirmed: 2; held back by contradictions: 0.');
        expect(sections()).toContain('Confirmed recently (2)');
    });

    it('lists disputed facts with a way to the Inbox', async () => {
        env.canon.items.push(canonItem(0, 'Эльмира', 'Elmira never had any festivals.'));
        env.contradictions.rule = (input) =>
            input.against.length ? [contradiction('Эльмира', 'праздник', 'never had any festivals')] : [];
        await turn(env, living, 'В Эльмире начинался Праздник Фонарей — каждый год жители запускают фонари.');
        render();
        expect(sections()).toContain('Disputed (1)');
        expect(container.textContent).toContain('waiting in the Inbox');
        expect(container.textContent).toContain('never had any festivals');
        buttonByText('Inbox').click();
        expect(env.ui.opened).toEqual(['inbox']);
        buttonByText('Drop').click();
        await flush(living);
        await redraw();
        expect(sections()).not.toContain('Disputed (1)');
    });

    it('queues the extraction and edits the settings', async () => {
        await turn(env, living, 'Тихий вечер.');
        render();
        buttonByText('Extract now').click();
        await flush(living);
        expect(env.tasks.queued.map((task) => task.kind)).toEqual(['living.extract']);
        expect(env.ui.notices.at(-1)?.text).toContain('The extraction is queued');
        const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
        expect(inputs.map((input) => input.value)).toEqual(['3', '10', '10']);
        inputs[0]!.value = '5';
        inputs[0]!.dispatchEvent(new Event('change'));
        inputs[1]!.value = '-4';
        inputs[1]!.dispatchEvent(new Event('change'));
        expect(env.settings.module('livingCanon')).toMatchObject({ maxPerTurn: 5, surviveTurns: 0 });
    });

    it('explains an empty chat, a group chat and a missing canon', async () => {
        env.modules.apis.delete('canon');
        render();
        expect(container.textContent).toContain('The chat canon (M6) is off');
        if (typeof unmount === 'function') unmount();
        env.host.group = true;
        render();
        expect(container.textContent).toContain('Group chats are not supported');
        if (typeof unmount === 'function') unmount();
        env.mock.chatId = undefined;
        render();
        expect(container.textContent).toContain('No chat is open.');
    });
});
