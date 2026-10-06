// @vitest-environment happy-dom
// The «Голоса» pult tab: cards with tokens, attitudes between characters, the whole insert, the CK quiet mode status
// (the CarrotKernel hint taken out, DES-RU told) and the settings.
import { afterEach, describe, expect, it } from 'vitest';
import { VOICES_TAB, voicesTab } from '../../../src/features/voices/view';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { FakeArchitect, changeChat, generate, relation, startVoices, userMessage } from './helpers';
import type { Msg, VoicesTestApp } from './helpers';

const CK = 'OOC MANDATORY: [CHARACTER CONTEXT - CarrotKernel Tags]\nAnna: ELF\n';

let app: VoicesTestApp | null = null;
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

async function settleUi(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 150));
}

async function render(started: VoicesTestApp): Promise<HTMLElement> {
    container = document.createElement('div');
    document.body.append(container);
    close = voicesTab(started.env.app, started.service).render(container);
    await settleUi();
    return container;
}

function text(root: HTMLElement): string {
    return root.textContent ?? '';
}

function toggleByLabel(root: HTMLElement, label: string): HTMLInputElement {
    const node = [...root.querySelectorAll('label')].find((item) => item.textContent?.includes(label));
    const input = node?.querySelector('input');
    if (!input) throw new Error(`no toggle "${label}"`);
    return input;
}

const prompt = (): Msg[] => [
    { role: 'system', content: 'Main prompt.' },
    { role: 'system', content: CK.trim() },
    { role: 'user', content: 'Anna?' },
];

describe('voices tab', () => {
    it('shows the cards with their tokens, the bonds and the whole insert', async () => {
        app = await startVoices({ relations: [relation('Anna', 'Corvin', [[1, 'Distrust']])] });
        const root = await render(app);
        expect(voicesTab(app.env.app, app.service)).toMatchObject({ id: VOICES_TAB, titleKey: 'm15.tab', order: 56 });
        const titles = [...root.querySelectorAll('.maestro-card-title')].map((node) => node.textContent);
        expect(titles).toEqual(['Anna', 'Corvin', 'Stranger']);
        const anna = app.api.cards()[0]!;
        expect(text(root)).toContain(anna.text);
        expect(text(root)).toContain(`${anna.tokens} tokens`);
        expect(text(root)).toContain('Cards: 3 ·');
        expect(text(root)).toContain('own limit');
        expect(text(root)).toContain('[Bond] Anna → Corvin: Distrust');
        expect(root.querySelector('.maestro-m15-pre')?.textContent).toBe(app.service.injection().text);
    });

    it('shows the quiet mode status: waiting, silenced, not found, DES-RU told', async () => {
        app = await startVoices();
        const root = await render(app);
        expect(text(root)).toContain('The CarrotKernel hint is taken out from the next reply on');
        expect(text(root)).toContain('DES-RU knows ✓');

        await generate(app, prompt(), { ck: CK });
        await settleUi();
        expect(text(root)).toMatch(/CarrotKernel hint taken out ✓ \(last reply: −\d+ tokens/);

        await generate(app, [{ role: 'user', content: 'elsewhere' }], { ck: CK });
        await settleUi();
        expect(text(root)).toContain('CarrotKernel hint not taken out ✗');
        expect(root.querySelector('.maestro-lamp-error')).not.toBeNull();
    });

    it('reports no cards, DES-RU missing, and no chat', async () => {
        app = await startVoices({ chat: [userMessage('Hi.')], desru: null });
        const root = await render(app);
        expect(text(root)).toContain('No cards');
        expect(text(root)).toContain('The CarrotKernel hint stays: there are no cards');
        expect(text(root)).toContain('No need to tell DES-RU (no DES-RU 0.8+)');
        await changeChat(app, undefined);
        await settleUi();
        expect(text(root)).toContain('No chat is open.');
        expect(text(root)).toContain('Token limit for all cards');
    });

    it('changes the settings: goals, attitudes between characters, the cap; tells when the architect decides', async () => {
        app = await startVoices({ relations: [relation('Anna', 'Corvin', [[1, 'Distrust']])] });
        const root = await render(app);
        const goals = toggleByLabel(root, 'Current goals');
        goals.checked = false;
        goals.dispatchEvent(new Event('change'));
        await settleUi();
        expect(app.service.settings().goals).toBe(false);
        expect(app.api.cards()[0]?.goals).toBeUndefined();
        expect(text(root)).not.toContain('Goals:');

        const bonds = toggleByLabel(root, 'Attitudes between present characters');
        bonds.checked = false;
        bonds.dispatchEvent(new Event('change'));
        await settleUi();
        expect(app.service.settings().npcAttitudes).toBe(false);
        expect(text(root)).not.toContain('[Bond]');

        const cap = root.querySelector<HTMLInputElement>('input.maestro-number');
        if (!cap) throw new Error('no cap input');
        cap.value = '20';
        cap.dispatchEvent(new Event('change'));
        await settleUi();
        expect(app.service.settings().cap).toBe(100);
        expect(text(root)).toContain('Shortened to fit');

        app.env.modules.expose('architect', new FakeArchitect(900));
        app.env.settings.notify('m20.budgets');
        await settleUi();
        expect(text(root)).toContain('The Architect’s «Voices» budget (900 tokens) applies now.');
        expect(text(root)).toContain('budget from the Architect');
    });
});
