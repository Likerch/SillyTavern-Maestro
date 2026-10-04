// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revisionTab } from '../../../src/features/revision/view';
import { answer, change, createRevision, createRevisionTestApp, seedAnna } from './helpers';
import type { RevisionParts, RevisionTestApp } from './helpers';

let env: RevisionTestApp;
let parts: RevisionParts;
let container: HTMLElement;

beforeEach(() => {
    env = createRevisionTestApp();
    parts = createRevision(env);
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    parts.dispose();
    container.remove();
});

const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const buttonByText = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);

describe('pult tab «Ревизия»', () => {
    it('shows the trigger state, the last runs with changes, rejections and cost', async () => {
        seedAnna(env);
        env.llm.script = [answer(change(), change({ target: 'nai.appearance', field: 'hair', value: 'Short Hair' }))];
        await parts.service.execute('signals');
        env.signals.since = 4;
        const tab = revisionTab(env.app, parts.service);
        expect(tab).toMatchObject({ id: 'revision', titleKey: 'm8.tab', order: 49 });
        const off = tab.render(container) as () => void;
        const text = container.textContent ?? '';
        expect(text).toContain('Signals waiting: 0 · messages since the last revision: 4');
        expect(text).toContain('signals');
        expect(text).toContain('messages #0–#4');
        expect(text).toContain('Cost: $0.0020');
        expect(text).toContain('Changes: 1');
        expect(text).toContain('canon fact · Anna: Anna now lives in Paris.');
        expect(text).toContain('Rejected: 1');
        expect(text).toContain('appearance · Anna: Short Hair — passport tags must be lower case: Short Hair');
        expect(text).not.toContain('The signals service is off');
        off();
    });

    it('shows a failed run and the fallback status without the signals service', async () => {
        parts.dispose();
        env.modules.apis.delete('signals');
        parts = createRevision(env);
        env.llm.script = [{ ok: false, error: 'no-profile' }];
        await parts.service.execute('manual');
        revisionTab(env.app, parts.service).render(container);
        expect(container.textContent).toContain('Not done: no connection profile for background tasks');
        expect(container.textContent).toContain('The signals service is off');
    });

    it('«Revise now» queues a run; settings change the slice', async () => {
        revisionTab(env.app, parts.service).render(container);
        expect(container.textContent).toContain('No revisions in this chat yet.');
        buttonByText('Revise now')!.click();
        await wait(20);
        expect(
            (env.app.tasks as unknown as { queued: { payload: unknown }[] }).queued.map((task) => task.payload),
        ).toEqual([{ reason: 'manual' }]);
        expect(env.ui.notices.map((notice) => notice.text)).toContain('The revision is queued.');
        const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
        inputs[0]!.value = '5';
        inputs[0]!.dispatchEvent(new Event('change'));
        inputs[1]!.value = '0';
        inputs[1]!.dispatchEvent(new Event('change'));
        inputs[2]!.value = '70';
        inputs[2]!.dispatchEvent(new Event('change'));
        const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        expect(parts.settings()).toEqual({ signalThreshold: 5, everyMessages: 0, sceneEnd: false, minConfidence: 0.7 });
    });

    it('a refused manual run is reported', async () => {
        revisionTab(env.app, parts.service).render(container);
        env.host.group = true;
        buttonByText('Revise now')!.click();
        await wait(20);
        expect(env.ui.notices.at(-1)).toMatchObject({
            text: 'Maestro sleeps in group chats.',
            options: { level: 'warn' },
        });
    });

    it('says so when no chat is open or the chat is a group', () => {
        env.mock.chatId = undefined;
        revisionTab(env.app, parts.service).render(container);
        expect(container.textContent).toContain('No chat is open.');
        container.textContent = '';
        env.mock.chatId = 'chat';
        env.host.group = true;
        revisionTab(env.app, parts.service).render(container);
        expect(container.textContent).toContain('Maestro sleeps in group chats.');
    });
});
