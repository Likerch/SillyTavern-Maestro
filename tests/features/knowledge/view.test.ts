// @vitest-environment happy-dom
// The «Кто знает» pult tab: the experimental banner, what the voice cards get now, facts with who knows them (secrets
// highlighted and first), «знает» toggles, the character filter and the settings.
import { afterEach, describe, expect, it } from 'vitest';
import { KNOWLEDGE_TAB } from '../../../src/features/knowledge/settings';
import { knowledgeTab } from '../../../src/features/knowledge/view';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { switchChat } from '../../helpers/core-host';
import { commit, createKnowledgeTestApp, settle, startKnowledge, trackerReply } from './helpers';
import type { KnowledgeTestApp, Started } from './helpers';

let started: Started | null = null;
let container: HTMLElement | null = null;
let close: Unsubscribe | void;

afterEach(() => {
    if (typeof close === 'function') close();
    close = undefined;
    container?.remove();
    container = null;
    started?.stop();
    started = null;
});

async function settleUi(): Promise<void> {
    await settle(20);
    await new Promise((resolve) => setTimeout(resolve, 150));
}

async function prepared(): Promise<{ env: KnowledgeTestApp; run: Started }> {
    const env = createKnowledgeTestApp();
    const run = startKnowledge(env);
    started = run;
    await commit(env, trackerReply([{ name: 'Bob' }], undefined, 'Bob stole the gold.'));
    await settle();
    await run.api.addSecret({ text: 'Anna is a spy', topics: ['Anna', 'Анна'], knownBy: ['Anna'], sourceMessage: 1 });
    // Now Anna and Corvin are in the scene and Anna's name came up.
    await commit(env, trackerReply([{ name: 'Anna' }, { name: 'Corvin' }], undefined, 'Anna smiles.'), 'Anna, wait.');
    await settle();
    return { env, run };
}

async function render(env: KnowledgeTestApp, run: Started): Promise<HTMLElement> {
    container = document.createElement('div');
    document.body.append(container);
    close = knowledgeTab(env.app, run.service).render(container);
    await settleUi();
    return container;
}

function toggleByLabel(root: HTMLElement, label: string, within?: Element): HTMLInputElement {
    const scope = within ?? root;
    const node = [...scope.querySelectorAll('label')].find((item) => item.textContent === label);
    const input = node?.querySelector('input');
    if (!input) throw new Error(`no toggle "${label}"`);
    return input;
}

function cardOf(root: HTMLElement, title: string): HTMLElement {
    const node = [...root.querySelectorAll('.maestro-card')].find(
        (item) => item.querySelector('.maestro-card-title')?.textContent === title,
    );
    if (!node) throw new Error(`no card "${title}"`);
    return node as HTMLElement;
}

describe('knowledge tab', () => {
    it('shows the banner, what the cards get now and the facts with who knows them, secrets first', async () => {
        const { env, run } = await prepared();
        const root = await render(env, run);
        expect(knowledgeTab(env.app, run.service)).toMatchObject({ id: KNOWLEDGE_TAB, titleKey: 'm18.tab', order: 59 });
        expect(root.querySelector('.maestro-banner')?.textContent).toContain('Experimental module');
        expect(root.textContent).toContain('Corvin: Anna is a spy');
        expect(root.textContent).toContain('The «Character voices» module is off');
        const titles = [...root.querySelectorAll('.maestro-card-title')].map((node) => node.textContent);
        expect(titles).toEqual(['Anna is a spy', 'Theft involving Bob']);
        const secret = cardOf(root, 'Anna is a spy');
        expect(secret.classList.contains('maestro-m18-secret')).toBe(true);
        expect(secret.textContent).toContain('secret');
        expect(secret.textContent).toContain('Known to: Anna');
        expect(cardOf(root, 'Theft involving Bob').textContent).toContain('Known to: Bob, Kai');
        expect(cardOf(root, 'Theft involving Bob').textContent).toContain('Bob stole the gold.');
    });

    it('marks who knows with the toggles of the characters in the scene', async () => {
        const { env, run } = await prepared();
        const root = await render(env, run);
        const secret = cardOf(root, 'Anna is a spy');
        const corvin = toggleByLabel(root, 'Corvin knows', secret);
        expect(toggleByLabel(root, 'Anna knows', secret).checked).toBe(true);
        expect(corvin.checked).toBe(false);
        corvin.checked = true;
        corvin.dispatchEvent(new Event('change'));
        await settleUi();
        expect(run.api.facts().find((fact) => fact.secret)?.knownBy).toEqual(['Anna', 'Corvin']);
        expect(root.textContent).toContain('Known to: Anna, Corvin');
        expect(root.textContent).not.toContain('Corvin: Anna is a spy');
        expect(env.journal.records.at(-1)?.kind).toBe('knowledge.known');

        const again = toggleByLabel(root, 'Corvin knows', cardOf(root, 'Anna is a spy'));
        again.checked = false;
        again.dispatchEvent(new Event('change'));
        await settleUi();
        expect(run.api.facts().find((fact) => fact.secret)?.knownBy).toEqual(['Anna']);
    });

    it('filters by character into «does not know» and «knows»', async () => {
        const { env, run } = await prepared();
        const root = await render(env, run);
        const filter = root.querySelector('select') as HTMLSelectElement;
        expect([...filter.options].map((option) => option.value)).toEqual(['', 'Anna', 'Corvin', 'Bob']);
        filter.value = 'Bob';
        filter.dispatchEvent(new Event('change'));
        await settleUi();
        expect(root.textContent).toContain('Bob does not know (1)');
        expect(root.textContent).toContain('Bob knows (1)');
        const toggle = toggleByLabel(root, 'Bob knows', cardOf(root, 'Anna is a spy'));
        expect(toggle.checked).toBe(false);
        expect(root.querySelectorAll('.maestro-m18-toggles label')).toHaveLength(2);
    });

    it('says when nothing is known, and when no chat is open; the settings are saved', async () => {
        const env = createKnowledgeTestApp();
        const run = startKnowledge(env);
        started = run;
        const root = await render(env, run);
        expect(root.textContent).toContain('Nothing known yet');
        const replyEvents = toggleByLabel(
            root,
            'Also read replies for key events (a kiss, a death, a theft…) that name someone',
        );
        replyEvents.checked = false;
        replyEvents.dispatchEvent(new Event('change'));
        const max = root.querySelector('input[type="number"]') as HTMLInputElement;
        max.value = '10';
        max.dispatchEvent(new Event('change'));
        expect(env.knowledgeSettings()).toEqual({ maxFacts: 50, replyEvents: false });

        await switchChat(env.mock, undefined);
        await env.app.bus.emit('chat:changed', { chatId: null });
        await settleUi();
        expect(root.textContent).toContain('No chat is open.');
        expect(root.querySelector('.maestro-banner')).not.toBeNull();
    });

    it('reports a failed mark', async () => {
        const { env, run } = await prepared();
        const root = await render(env, run);
        const toggle = toggleByLabel(root, 'Corvin knows', cardOf(root, 'Anna is a spy'));
        await run.service.store.mutate((doc) => {
            doc.facts = doc.facts.filter((fact) => !fact.secret);
            return { changed: true, result: null };
        });
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await settleUi();
        expect(env.ui.notices.map((notice) => notice.text)).toContain('This fact is gone.');
    });
});
