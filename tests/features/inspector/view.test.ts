// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMPT_TAB, inspectorModule } from '../../../src/features/inspector';
import type { InspectorSettings } from '../../../src/features/inspector';
import type { InspectorApi } from '../../../src/features/inspector/api';
import { loreJournalModule } from '../../../src/features/loreJournal';
import type { PultTab } from '../../../src/shared/contracts';
import { changeChat, createLoreApp, finishReply, settle, startGeneration } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';
import { finalList, scanPayloads, wiEntry } from '../../helpers/lore-fixtures';
import { FACT, installPromptManager, installSlots, promptMessages } from '../../helpers/lore-prompt';

const anna = wiEntry('World', 1, { comment: 'Anna', key: ['Anna'], content: `${FACT} Anna is quiet.` });

async function until(check: () => boolean, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds && !check(); i++) await settle(5);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
    if (!found) throw new Error(`no button "${text}"`);
    return found;
}

describe('M2 tab «Промпт хода»', () => {
    let stand: LoreTestApp;
    let api: InspectorApi;
    let settings: InspectorSettings;
    let tab: PultTab;
    let container: HTMLElement;
    const stops: (() => Promise<void>)[] = [];

    async function playTurn(index: number, counts?: Record<string, number>): Promise<void> {
        if (counts) installPromptManager(stand, counts);
        await startGeneration(stand);
        for (const payload of scanPayloads([{ activated: [anna] }])) await stand.emit('WORLDINFO_SCAN_DONE', payload);
        await stand.emit('WORLD_INFO_ACTIVATED', finalList([{ activated: [anna] }]));
        await stand.emit('CHAT_COMPLETION_PROMPT_READY', { chat: promptMessages(), dryRun: false });
        await finishReply(stand, index);
        await until(() => api.turns().some((record) => record.messageIndex === index));
    }

    beforeEach(async () => {
        stand = createLoreApp();
        installPromptManager(stand, { main: 300, worldInfoBefore: 120, chatHistory: 900, dooms_tracker: 80 });
        installSlots(stand);
        stops.push((await stand.start(loreJournalModule)).stop);
        const started = await stand.start(inspectorModule);
        stops.push(started.stop);
        settings = started.settings;
        api = stand.app.modules.api<InspectorApi>('inspector')!;
        tab = stand.tabs.find((item) => item.id === PROMPT_TAB)!;
        container = document.createElement('div');
        document.body.append(container);
        await settle(10);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        container.remove();
        for (const stop of stops.splice(0).reverse()) await stop();
    });

    it('registers the tab', () => {
        expect(tab).toMatchObject({ titleKey: 'm2.tab', order: 21 });
        expect(stand.styles.has('maestro-m2')).toBe(true);
    });

    it('shows sections other modules add, in their order, and drops a failing one', async () => {
        const offs = [
            api.addSection!({
                id: 'b',
                order: 2,
                render: () => Object.assign(document.createElement('div'), { textContent: 'Second block' }),
            }),
            api.addSection!({
                id: 'a',
                order: 1,
                render: () => Object.assign(document.createElement('div'), { textContent: 'First block' }),
            }),
            api.addSection!({
                id: 'broken',
                order: 3,
                render: () => {
                    throw new Error('boom');
                },
            }),
            api.addSection!({ id: 'hidden', order: 4, render: () => null }),
        ];
        const dispose = tab.render(container);
        await playTurn(3);
        const text = container.textContent ?? '';
        expect(text.indexOf('First block')).toBeGreaterThan(-1);
        expect(text.indexOf('First block')).toBeLessThan(text.indexOf('Second block'));
        for (const off of offs) off();
        dispose?.();
    });

    it('shows the weights, deltas and repeated facts of the last turn', async () => {
        const dispose = tab.render(container);
        await settle(20);
        expect(container.textContent).toContain('No turns yet.');

        await playTurn(3);
        let text = container.textContent ?? '';
        expect(text).toContain('Messages in the prompt: 3');
        expect(text).toContain('Counts by the Prompt Manager.');
        expect(text).toContain('Lore: World');
        expect(text).toContain('Chat history');
        expect(text).toContain('DES');
        expect(text).toContain('Qvink memory');
        expect(text).toContain('Lore wrapper');
        expect(container.querySelectorAll('.maestro-m2-seg').length).toBeGreaterThanOrEqual(4);
        // The same long sentence in Qvink's memory, the lore and the chat.
        const repeat = container.querySelector('.maestro-m2-repeat');
        expect(repeat?.textContent).toContain(FACT);
        expect(repeat?.textContent).toContain('Qvink memory');
        expect(repeat?.textContent).toContain('Lore: World');
        expect(repeat?.textContent).toContain('Chat history');

        await playTurn(5, { main: 200, worldInfoBefore: 120, chatHistory: 1000, dooms_tracker: 80 });
        text = container.textContent ?? '';
        expect(text).toContain('+100');
        expect(text).toContain('−100');
        const picker = container.querySelector<HTMLSelectElement>('select')!;
        expect(picker.options).toHaveLength(2);
        picker.value = picker.options[1]!.value;
        picker.dispatchEvent(new Event('change'));
        // An older turn: its texts are not kept.
        expect(container.textContent).toContain('Available for the last turn of this session');
        expect(container.textContent).toContain('the export has weights only');

        if (typeof dispose === 'function') dispose();
        container.textContent = '';
        await playTurn(7);
        expect(container.textContent).toBe('');
    });

    it('exports the turn without secrets, with the chat text hidden by default', async () => {
        tab.render(container);
        await playTurn(3);
        let exported = '';
        const createObjectURL = vi.fn((blob: Blob) => {
            void blob.text().then((value) => {
                exported = value;
            });
            return 'blob:test';
        });
        Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
        buttonByText(container, 'Download JSON').click();
        await until(() => exported.length > 0);
        const payload = JSON.parse(exported) as Record<string, unknown>;
        expect(payload).toMatchObject({ format: 'maestro-turn', redactedChat: true, preset: 'Test preset' });
        expect(exported).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
        expect(exported).toContain('[secret]');
        expect(exported).not.toContain('Tell me.');
        const prompt = payload.prompt as { role: string; redacted?: boolean }[];
        expect(prompt.map((item) => item.redacted ?? false)).toEqual([false, true, true]);
        expect((payload.lore as { activations: unknown[] }).activations).toHaveLength(1);

        const writes: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (value: string) => void writes.push(value) },
        });
        const redact = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        redact.checked = false;
        redact.dispatchEvent(new Event('change'));
        buttonByText(container, 'Copy JSON').click();
        await until(() => (container.textContent ?? '').includes('Copied.'));
        expect(writes[0]).toContain('Tell me.');

        // Plain HTTP: no Clipboard API, the textarea fallback is used.
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        const commands: string[] = [];
        Object.assign(document, { execCommand: (command: string) => commands.push(command) > 0 });
        buttonByText(container, 'Copy JSON').click();
        await until(() => commands.length > 0);
        expect(commands).toEqual(['copy']);
        expect(document.querySelector('textarea')).toBeNull();
    });

    it('explains Text Completion, empty chats and keeps its settings', async () => {
        stand.app.host.isChatCompletion = () => false;
        tab.render(container);
        await settle(20);
        expect(container.textContent).toContain('Chat Completion mode only');
        const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
        input.value = '40';
        input.dispatchEvent(new Event('change'));
        expect(settings.keepTurns).toBe(40);
        await changeChat(stand, undefined);
        tab.render(container);
        expect(container.textContent).toContain('Open a chat');
    });

    it('shows lore as one source when the journal is off', async () => {
        await stops.shift()!();
        tab.render(container);
        await playTurn(3);
        expect(container.textContent).toContain('The lore journal is off');
        expect(container.textContent).toContain('Lore (all books)');
    });
});
