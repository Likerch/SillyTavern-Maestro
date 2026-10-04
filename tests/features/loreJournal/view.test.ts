// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TURN_TAB, loreJournalModule } from '../../../src/features/loreJournal';
import type { LoreJournalApi } from '../../../src/features/loreJournal/api';
import type { LoreJournalSettings } from '../../../src/features/loreJournal';
import type { PultTab } from '../../../src/shared/contracts';
import { changeChat, createLoreApp, finishReply, settle, startGeneration } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';
import { finalList, scanPayloads, wiEntry } from '../../helpers/lore-fixtures';
import type { LoopSpec } from '../../helpers/lore-fixtures';
import { message } from '../../helpers/st-mock';

const anna = wiEntry('World', 1, { comment: 'Anna', key: ['Anna'], content: 'Anna lives in the Silver Tower.' });
const tower = wiEntry('World', 2, {
    comment: '',
    key: ['silver tower'],
    content: 'The tower is tall.',
    position: 4,
    depth: 3,
    role: 2,
});
const huge = wiEntry('World', 4, { comment: 'Huge', key: ['tower'], content: 'x'.repeat(50), position: 9 });
const LOOPS: LoopSpec[] = [{ activated: [anna] }, { current: 2, activated: [tower], cut: [huge], overflowed: true }];

async function until(check: () => boolean, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds && !check(); i++) await settle(5);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
    if (!found) throw new Error(`no button "${text}"`);
    return found;
}

describe('M1 tab «Лор хода»', () => {
    let stand: LoreTestApp;
    let api: LoreJournalApi;
    let settings: LoreJournalSettings;
    let stop: () => Promise<void>;
    let tab: PultTab;
    let container: HTMLElement;

    async function playTurn(index: number): Promise<void> {
        await startGeneration(stand);
        for (const payload of scanPayloads(LOOPS)) await stand.emit('WORLDINFO_SCAN_DONE', payload);
        await stand.emit('WORLD_INFO_ACTIVATED', finalList(LOOPS));
        await finishReply(stand, index);
        await until(() => api.turns().some((record) => record.messageIndex === index));
    }

    beforeEach(async () => {
        stand = createLoreApp();
        stand.mock.chat.push(
            message('Hi', { is_user: true, name: 'User' }),
            message('Hello', { name: 'Anna' }),
            message('Tell me about Anna', { is_user: true, name: 'User' }),
        );
        stand.worldInfo.selected_world_info = ['World'];
        stand.books.set('World', { entries: {} });
        stand.worldInfo.checkWorldInfo = async () => {
            for (const payload of scanPayloads([{ activated: [anna] }]))
                await stand.emit('WORLDINFO_SCAN_DONE', payload);
            return { allActivatedEntries: new Set([anna]) };
        };
        const started = await stand.start(loreJournalModule);
        stop = started.stop;
        settings = started.settings;
        api = stand.app.modules.api<LoreJournalApi>('loreJournal')!;
        tab = stand.tabs.find((item) => item.id === TURN_TAB)!;
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        container.remove();
        await stop();
    });

    it('registers the tab and its stylesheet', () => {
        expect(tab).toMatchObject({ titleKey: 'm1.tab', order: 20 });
        expect(stand.styles.has('maestro-m1')).toBe(true);
    });

    it('shows an empty journal, then the turn, keys, reasons and the summary', async () => {
        const dispose = tab.render(container);
        await settle(30);
        expect(container.textContent).toContain('No turns recorded in this chat yet');
        expect(container.textContent).toContain('global list');

        await playTurn(3);
        await settle(10);
        const text = container.textContent ?? '';
        expect(text).toContain('Entries in the prompt: 2');
        expect(text).toContain('The budget overflowed');
        expect(text).toContain('Cut: 1');
        expect(text).toContain('entry #2');
        expect(text).toContain('depth 3, assistant');
        expect(text).toContain('position 9');
        expect(text).toContain('2 · recursion 1');
        expect(text).toContain('World › Anna');
        expect(text).toContain('Turns counted: 1');
        expect(container.querySelectorAll('.maestro-m1-cut')).toHaveLength(1);

        buttonByText(container, 'Which key?').click();
        await until(() => (container.textContent ?? '').includes('Keys found for'));
        expect(container.textContent).toContain('Keys found for 3 of 3 entries.');
        expect(container.textContent).toContain('silver tower');

        // A second turn adds the turn picker.
        await playTurn(5);
        await settle(10);
        const picker = container.querySelector<HTMLSelectElement>('select')!;
        expect(picker.options).toHaveLength(2);
        picker.value = picker.options[1]!.value;
        picker.dispatchEvent(new Event('change'));
        expect(container.textContent).toContain('Message #3');

        if (typeof dispose === 'function') dispose();
        container.textContent = '';
        await playTurn(7);
        expect(container.textContent).toBe('');
    });

    it('runs «what if» and reports a busy generation', async () => {
        tab.render(container);
        await settle(30);
        await playTurn(3);
        stand.generation = { type: 'normal', dryRun: false, quiet: false };
        buttonByText(container, 'What if I send now?').click();
        await settle(20);
        expect(container.textContent).toContain('Wait until the generation finishes.');
        stand.generation = null;
        buttonByText(container, 'What if I send now?').click();
        await until(() => (container.textContent ?? '').includes('Would go into the prompt'));
        expect(container.textContent).toContain('Would go into the prompt: 1 entries');
        expect(container.textContent).toContain('Compared with the last turn: +0 / −1 entries');
        expect(container.textContent).toContain('Sticky and cooldown are not evaluated');
        // Keys of the simulation.
        const keyButtons = [...container.querySelectorAll('button')].filter((node) =>
            node.textContent?.includes('Which key?'),
        );
        keyButtons[1]!.click();
        await until(() => (container.textContent ?? '').includes('Keys found for'));

        delete stand.worldInfo.checkWorldInfo;
        buttonByText(container, 'What if I send now?').click();
        await until(() => (container.textContent ?? '').includes('The dry run failed'));
    });

    it('edits the number of kept turns and handles «no chat»', async () => {
        tab.render(container);
        await settle(30);
        const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
        input.value = '55';
        input.dispatchEvent(new Event('change'));
        expect(settings.keepTurns).toBe(55);
        await changeChat(stand, undefined);
        tab.render(container);
        await settle(30);
        expect(container.textContent).toContain('Open a chat');
    });

    it('survives a failing why-active check', async () => {
        stand.app.host.modules.worldInfo = async () => {
            throw new Error('nope');
        };
        stand.ctx.getWorldInfoNames = () => {
            throw new Error('broken');
        };
        tab.render(container);
        await settle(40);
        expect(container.textContent).toContain('No active lorebooks.');
    });
});
