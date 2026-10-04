// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costFileName } from '../../../src/core/cost';
import { dayKey } from '../../../src/domain/treasurer-spend';
import { TREASURER_TAB, treasurerTab } from '../../../src/features/treasurer';
import type { TreasurerService } from '../../../src/features/treasurer';
import type { PultTab } from '../../../src/shared/contracts';
import { changeChat } from '../../helpers/lore-app';
import { chatMessage, createTreasurerStand, userMessage, wait } from './treasurer-app';
import type { TreasurerStand } from './treasurer-app';

async function until(check: () => boolean, rounds = 100): Promise<void> {
    for (let i = 0; i < rounds && !check(); i++) await wait(5);
}

function sections(container: HTMLElement): Map<string, HTMLElement> {
    const map = new Map<string, HTMLElement>();
    for (const node of container.querySelectorAll<HTMLElement>('.maestro-section')) {
        map.set(node.querySelector('.maestro-section-title')?.textContent ?? '', node);
    }
    return map;
}

function rowTexts(node: HTMLElement | undefined): string[][] {
    return [...(node?.querySelectorAll('tbody tr') ?? [])].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''),
    );
}

describe('M21 tab «Расходы»', () => {
    let env: TreasurerStand;
    let service: TreasurerService;
    let stop: () => void;
    let container: HTMLElement;
    let dispose: (() => void) | void;
    let tab: PultTab;

    const turn = async (usd: number, extra: () => void = () => {}) => {
        env.stand.mock.chat.push(userMessage('…'));
        env.wall.value += 1000;
        await env.begin('normal');
        env.wall.value += 1000;
        env.record({ source: 'main', task: 'normal', usd, tokens: { prompt: 100, completion: 20 } });
        extra();
        const index = env.stand.mock.chat.length;
        await env.reply(index, chatMessage(`Reply ${index}`));
        await env.ended();
        service.process();
        return index;
    };

    beforeEach(async () => {
        env = createTreasurerStand();
        env.stand.mock.chat.push(chatMessage('Greeting'));
        ({ service, stop } = env.makeService());
        await wait();
        tab = treasurerTab(env.app, service);
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(() => {
        if (typeof dispose === 'function') dispose();
        dispose = undefined;
        container.remove();
        stop();
    });

    it('shows totals by source, turns newest first with estimates marked, and the day chart', async () => {
        const yesterday = dayKey(env.wall.value - 24 * 60 * 60 * 1000);
        env.files.set(costFileName(yesterday), {
            date: yesterday,
            totalUsd: 0.5,
            bySource: { main: 0.5 },
            byTask: { normal: 0.5 },
            anlas: 10,
            recent: [],
        });
        await turn(0.01);
        const second = await turn(0.02, () => {
            env.record({
                source: 'maestro',
                task: 'revision',
                usd: 0,
                estimated: true,
                tokens: { prompt: 300, completion: 40 },
            });
            env.record({ source: 'nai', usd: 0, anlas: 15 });
        });
        dispose = tab.render(container);
        expect(tab).toMatchObject({ id: TREASURER_TAB, titleKey: 'm21.tab', order: 54, icon: 'fa-coins' });
        await until(() => container.querySelectorAll('.maestro-m21-day').length > 0);

        const parts = sections(container);
        const totals = rowTexts(parts.get('Totals'));
        expect(totals.map((row) => row[0])).toEqual([
            'Main model',
            'Regenerations',
            'Auto-swipes',
            'Qvink',
            'Maestro tasks',
            'NAI Studio (LLM)',
            'NAI pictures, Anlas',
            'Other',
            'Total',
        ]);
        expect(totals[0]).toEqual(['Main model', '$0.02', '$0.03', '$0.03']);
        expect(totals[1]).toEqual(['Regenerations', '—', '—', '—']);
        expect(totals[4]).toEqual(['Maestro tasks', '$0.00estimate', '$0.00estimate', '$0.00estimate']);
        expect(totals[6]).toEqual(['NAI pictures, Anlas', '15', '15', '15']);
        expect(totals[8]![1]).toBe('$0.02estimate');
        expect(parts.get('Totals')?.querySelector('tbody tr:last-child')?.classList.contains('maestro-m21-total')).toBe(
            true,
        );

        const turns = rowTexts(parts.get('By turn'));
        expect(turns.map((row) => row[0])).toEqual([`#${second}`, '#2']);
        expect(turns[0]).toEqual([
            `#${second}`,
            '$0.02',
            '—',
            '—',
            '—',
            '$0.00estimate',
            '—',
            '15',
            '—',
            '$0.02estimate',
        ]);
        expect(parts.get('By turn')?.querySelector('.maestro-m21-est')?.getAttribute('title')).toBe(
            'Some answers had no cost in them: only their tokens are known. 300 in / 40 out',
        );

        const bars = [...container.querySelectorAll<HTMLElement>('.maestro-m21-day')];
        expect(bars).toHaveLength(14);
        expect(bars[13]!.classList.contains('maestro-m21-today')).toBe(true);
        expect(bars[12]!.getAttribute('title')).toContain('$0.50, 10 Anlas');
        expect(bars[12]!.querySelector<HTMLElement>('.maestro-m21-bar')!.style.height).toBe('100%');
        expect(bars[13]!.querySelector<HTMLElement>('.maestro-m21-bar')!.style.height).toBe('6%');
        expect(bars[0]!.querySelector<HTMLElement>('.maestro-m21-bar')!.style.height).toBe('0%');
        expect(container.textContent).toContain('Over 14 days: $0.53 and 25 Anlas');
    });

    it('edits the background cap and the daily limit like the Settings tab and links to it', async () => {
        env.core.dailyLimit = { enabled: false, usd: 2, action: 'warn' };
        dispose = tab.render(container);
        const limits = sections(container).get('Caps and limits')!;
        expect(limits.textContent).toContain("Maestro's background today$0.00 of $0.50");
        const [cap, limitUsd] = [...limits.querySelectorAll<HTMLInputElement>('input[type="number"]')];
        cap!.value = '1.25';
        cap!.dispatchEvent(new Event('change'));
        expect(env.core.backgroundDailyCapUsd).toBe(1.25);
        limitUsd!.value = '3';
        limitUsd!.dispatchEvent(new Event('change'));
        expect(env.core.dailyLimit.usd).toBe(3);
        const checkbox = limits.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
        expect(env.core.dailyLimit.enabled).toBe(true);
        const action = limits.querySelector<HTMLSelectElement>('select')!;
        expect([...action.options].map((option) => option.textContent)).toEqual([
            'Warn',
            'Switch to Economy',
            'Stop background tasks',
        ]);
        action.value = 'economy';
        action.dispatchEvent(new Event('change'));
        expect(env.core.dailyLimit.action).toBe('economy');
        expect(env.settingsNotified).toEqual([
            'core.backgroundDailyCapUsd',
            'core.dailyLimit.usd',
            'core.dailyLimit.enabled',
            'core.dailyLimit.action',
        ]);
        const open = [...limits.querySelectorAll('button')].find((node) => node.textContent?.includes('All settings'))!;
        open.click();
        expect(env.opened).toEqual(['settings']);
    });

    it('shows the cap and limit states, an empty chat and a missing chat', async () => {
        env.record({ source: 'maestro', task: 'revision', usd: 0.6 });
        env.limitReached.value = true;
        env.core.dailyLimit = { enabled: true, usd: 0.5, action: 'warn' };
        dispose = tab.render(container);
        expect(container.textContent).toContain(
            "The background cap is reached: Maestro's own tasks wait until tomorrow.",
        );
        expect(container.textContent).toContain('The overall daily limit is reached: $0.60 of $0.50.');
        expect(container.textContent).toContain('No spend recorded in this chat yet.');

        env.stand.mock.chat = [];
        await changeChat(env.stand, undefined);
        if (typeof dispose === 'function') dispose();
        dispose = tab.render(container);
        expect(container.textContent).toContain('Open a chat to see the spend per turn.');
    });

    it('redraws after new spend', async () => {
        dispose = tab.render(container);
        expect(rowTexts(sections(container).get('By turn'))).toEqual([]);
        await turn(0.01);
        await until(() => rowTexts(sections(container).get('By turn')).length > 0);
        expect(rowTexts(sections(container).get('By turn'))[0]![0]).toBe('#2');
        const refresh = [...container.querySelectorAll('button')].find((node) =>
            node.textContent?.includes('Refresh'),
        )!;
        refresh.click();
        await wait(350);
        expect(rowTexts(sections(container).get('By turn'))).toHaveLength(1);
    });
});
