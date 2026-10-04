// @vitest-environment happy-dom
// The «Архитектор» pult tab and the module: budgets with usage, presence settings, repeated facts with consent
// buttons, cache stats, the last report; tab registration, API exposure and the inspector section hook.
import { afterEach, describe, expect, it } from 'vitest';
import { architectModule } from '../../../src/features/architect';
import type { ArchitectApi } from '../../../src/features/architect/api';
import { ARCHITECT_TAB, architectTab, inspectorSection } from '../../../src/features/architect/view';
import { defaultArchitectSettings } from '../../../src/features/architect/settings';
import { ARCHITECT_STRINGS } from '../../../src/features/architect/strings';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createRulesTestApp } from '../../helpers/rules-app';
import { book, entry } from '../../helpers/rules-wi';
import { architectSettings, runTurn, setPrompts, startArchitect, trackerReply, userMessage } from './helpers';
import type { ArchitectTestApp } from './helpers';

const SCAR = 'Anna has an old scar across her left cheek from the war.';

let app: ArchitectTestApp | null = null;
let container: HTMLElement | null = null;
let close: Unsubscribe | void;

afterEach(async () => {
    if (typeof close === 'function') close();
    close = undefined;
    container?.remove();
    container = null;
    await app?.stop();
    app = null;
});

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
    if (!found) throw new Error(`no button "${text}"`);
    return found;
}

async function settleUi(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(started: ArchitectTestApp): Promise<HTMLElement> {
    container = document.createElement('div');
    document.body.append(container);
    close = architectTab(started.env.app, started.service).render(container);
    await settleUi();
    return container;
}

async function playTurn(started: ArchitectTestApp): Promise<void> {
    started.env.mock.chat = [userMessage('Hi.'), trackerReply('Anna waves.', ['Anna']), userMessage('The scar?')];
    const short = `[Following is a list of recent events]:\n* ${SCAR}\n`;
    setPrompts(started, { qvink_memory_short: { value: short, position: 1, depth: 2 } });
    await runTurn(started, {
        books: [book('World', [entry(1, { comment: 'Notes', key: ['scar'], content: SCAR })])],
        chatText: 'scar',
        messages: [
            { role: 'system', content: `Info: ${SCAR}` },
            { role: 'system', content: short.trim() },
            { role: 'user', content: 'The scar?' },
        ],
    });
}

describe('the architect tab', () => {
    it('shows budgets with inputs and usage, and saves a new budget', async () => {
        app = await startArchitect();
        architectSettings(app).budgets.lore = 1000;
        const root = await render(app);
        const inputs = root.querySelectorAll<HTMLInputElement>('.maestro-m20-budget input[type="number"]');
        expect(inputs).toHaveLength(7);
        expect(root.textContent).toContain('Lore (all books)');
        expect(root.textContent).toContain('No source yet');
        await playTurn(app);
        await settleUi();
        expect(root.textContent).toContain('of 1,000');
        const lore = root.querySelector<HTMLInputElement>('[data-source="lore"] input')!;
        lore.value = '2500';
        lore.dispatchEvent(new Event('change'));
        await settleUi();
        expect(app.api.budgets()[0]).toEqual({ source: 'lore', tokens: 2500 });
        expect(root.querySelector('.maestro-m20-fill')).not.toBeNull();
    });

    it('switches damping and pinning and sets K', async () => {
        app = await startArchitect();
        const root = await render(app);
        const toggles = [...root.querySelectorAll<HTMLLabelElement>('label.maestro-toggle')];
        const damp = toggles.find((node) => node.textContent?.includes('Damp lore'))!.querySelector('input')!;
        damp.checked = true;
        damp.dispatchEvent(new Event('change'));
        const pin = [...root.querySelectorAll<HTMLLabelElement>('label.maestro-toggle')]
            .find((node) => node.textContent?.includes('Pin lore'))!
            .querySelector('input')!;
        pin.checked = true;
        pin.dispatchEvent(new Event('change'));
        const window = [...root.querySelectorAll<HTMLInputElement>('input[type="number"]')].find(
            (node) => node.getAttribute('aria-label') === 'A mention in the last K messages keeps an entry',
        )!;
        window.value = '9';
        window.dispatchEvent(new Event('change'));
        await settleUi();
        expect(architectSettings(app).presence).toEqual({ damp: true, pin: true, mentionWindow: 9 });
    });

    it('lists repeated facts with «keep only» buttons that store the consent', async () => {
        app = await startArchitect({
            world: [{ id: 'character:anna', kind: 'character', name: 'Anna', roster: true, present: true }],
        });
        const root = await render(app);
        expect(root.textContent).toContain('No repeated facts');
        await playTurn(app);
        await settleUi();
        expect(root.querySelector('.maestro-m20-fact-text')?.textContent).toBe(SCAR);
        buttonByText(root, 'Keep only Qvink memory').click();
        await settleUi();
        expect(app.api.duplicates()[0]!.keep).toBe('qvink_memory_short');
        expect(root.textContent).toContain('Kept: Qvink memory');
        buttonByText(root, 'Report only').click();
        await settleUi();
        expect(app.api.duplicates()[0]!.keep).toBeNull();
    });

    it('shows cache stats, the order check and the last report', async () => {
        app = await startArchitect();
        const root = await render(app);
        expect(root.textContent).toContain('No measured requests yet.');
        expect(root.textContent).toContain('No turn yet.');
        architectSettings(app).budgets.qvink = 5;
        await playTurn(app);
        await app.gate.send(
            '/api/backends/chat-completions/generate',
            { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) },
            new Response(
                JSON.stringify({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } } }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                },
            ),
        );
        await settleUi();
        await settleUi();
        expect(root.textContent).toContain('Hits 50%');
        expect(root.textContent).toContain('Qvink budget');
        expect(root.textContent).toContain("Maestro's changing injections sit at the end.");
    });

    it('warns when the rules module is off and shows an empty state without a chat', async () => {
        app = await startArchitect();
        await app.rules.stop();
        const root = await render(app);
        expect(root.textContent).toContain('The lore part of the architect runs inside the «Rules» module');
        app.env.mock.chatId = undefined;
        app.service.changed();
        expect(root.textContent).toContain('Open a chat');
    });

    it('renders the inspector section of the same turn', async () => {
        app = await startArchitect();
        architectSettings(app).budgets.qvink = 5;
        await playTurn(app);
        await app.env.app.bus.emit('reply:ready', { messageIndex: 2, type: 'normal' });
        const report = app.api.lastReport()!;
        const section = inspectorSection(app.env.app, app.service, { messageIndex: 2, at: report.at });
        expect(section?.textContent).toContain('Qvink budget');
        expect(inspectorSection(app.env.app, app.service, { messageIndex: 9, at: 0 })).toBeNull();
    });
});

describe('architectModule', () => {
    it('exposes the API, adds the tab and offers a section to an inspector that accepts one', async () => {
        const env = createRulesTestApp({ firstRunDone: true });
        env.settings.registerModule('architect', defaultArchitectSettings, true);
        env.app.i18n.register(ARCHITECT_STRINGS);
        const sections: { id: string }[] = [];
        env.modules.expose('inspector', {
            turns: () => [],
            last: () => undefined,
            onTurn: () => () => {},
            addSection: (section: { id: string }) => {
                sections.push(section);
                return () => sections.splice(sections.indexOf(section), 1);
            },
        });
        const disposers: (() => void | Promise<void>)[] = [];
        await architectModule.init({
            app: env.app,
            settings: env.settings.module('architect'),
            log: env.log,
            own: (dispose) => disposers.push(dispose),
        });
        expect(architectModule).toMatchObject({ id: 'M20', key: 'architect', stage: 7, titleKey: 'm20.title' });
        const api = env.modules.api<ArchitectApi>('architect');
        expect(api?.budgets()).toHaveLength(7);
        const tab = env.ui.tabs.find((item) => item.id === ARCHITECT_TAB);
        expect(tab).toMatchObject({ titleKey: 'm20.tab', order: 53 });
        expect(env.ui.styles.has('maestro-m20')).toBe(true);
        expect(sections.map((section) => section.id)).toEqual(['architect']);
        for (const dispose of disposers.splice(0).reverse()) await dispose();
        expect(env.ui.tabs.find((item) => item.id === ARCHITECT_TAB)).toBeUndefined();
        expect(sections).toEqual([]);
    });

    it('has every string in both languages', () => {
        expect(Object.keys(ARCHITECT_STRINGS.ru).sort()).toEqual(Object.keys(ARCHITECT_STRINGS.en).sort());
    });
});
