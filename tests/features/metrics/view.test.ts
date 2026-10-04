// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { METRICS_TAB, metricsModule } from '../../../src/features/metrics';
import type { MetricsApi, MetricsService } from '../../../src/features/metrics';
import { metricsTab } from '../../../src/features/metrics/view';
import type { MaestroModule, PultTab } from '../../../src/shared/contracts';
import { createMetricsStand } from './metrics-app';
import type { MetricsStand } from './metrics-app';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, rounds = 100): Promise<void> {
    for (let i = 0; i < rounds && !check(); i++) await wait(5);
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text));
    if (!found) throw new Error(`no button "${text}"`);
    return found;
}

describe('M21m tab «Замеры»', () => {
    let env: MetricsStand;
    let service: MetricsService;
    let stop: () => void;
    let container: HTMLElement;
    let dispose: (() => void) | void;
    let tab: PultTab;

    beforeEach(() => {
        env = createMetricsStand();
        ({ service, stop } = env.makeService());
        tab = metricsTab(env.app, service);
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(() => {
        if (typeof dispose === 'function') dispose();
        container.remove();
        stop();
        vi.restoreAllMocks();
    });

    it('shows the ten criteria with status, target and how they are measured', async () => {
        for (let i = 0; i < 3; i++) await env.generate();
        dispose = tab.render(container);
        await until(() => container.querySelectorAll('tbody tr').length > 0);
        expect(tab).toMatchObject({ id: METRICS_TAB, titleKey: 'm21m.tab', order: 90 });
        const rows = [...container.querySelectorAll('.maestro-table tbody')][0]!.querySelectorAll('tr');
        expect(rows).toHaveLength(10);
        const first = rows[0]!.textContent ?? '';
        expect(first).toContain('Added latency before the request (p95)');
        expect(first).toContain('≤ 200 ms on a PC, ≤ 600 ms on a phone');
        expect(first).toContain('PC: p95 2 ms (p50 2 ms, samples: 3)');
        expect(first).toContain('— no verdict');
        expect(first).toContain("Maestro's own code between the send and the request");
        expect(first).toContain('partly on the bench');
        expect(container.textContent).toContain('Turns measured: 3');
        expect(container.textContent).toContain('Every measured criterion is met.');
        expect(rows[5]!.querySelector('.maestro-m21m-ok')?.textContent).toBe('✅ met');
    });

    it('copies the report as Markdown and JSON', async () => {
        const writes: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (text: string) => void writes.push(text) },
        });
        dispose = tab.render(container);
        await until(() => container.querySelector('.maestro-table') !== null);
        buttonByText(container, 'Copy as Markdown').click();
        await until(() => writes.length === 1);
        expect(writes[0]).toContain('| № | Criterion | Target | Now | Status | How it is measured | Bench |');
        await until(() => container.textContent?.includes('Copied.') === true);
        buttonByText(container, 'Copy as JSON').click();
        await until(() => writes.length === 2);
        expect(JSON.parse(writes[1]!).criteria).toHaveLength(10);
    });

    it('shows the text to copy by hand when the clipboard fails', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: async () => {
                    throw new Error('denied');
                },
            },
        });
        (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
        dispose = tab.render(container);
        await until(() => container.querySelector('.maestro-table') !== null);
        buttonByText(container, 'Copy as Markdown').click();
        await until(() => container.querySelector('textarea.maestro-m21m-out') !== null);
        expect((container.querySelector('textarea.maestro-m21m-out') as HTMLTextAreaElement).value).toContain(
            '# Maestro',
        );
        expect(container.textContent).toContain('Could not copy');
    });

    it('compares lore, restarts the baseline and checks pack files', async () => {
        env.expose('rules', {
            list: () => [{ id: 'book.cap', enabled: true, definition: { kind: 'lore' }, lastChanges: [] }],
            isEnabled: () => false,
            compare: async () => ({
                before: { totalChars: 9000 },
                after: { totalChars: 3000 },
                removed: [{}],
                added: [],
            }),
        });
        env.expose('bookRoles', { all: () => [{ book: 'BunnyMo Core', role: 'bunnymo.core' }] });
        env.books.set('BunnyMo Core', '{"entries":{}}');
        dispose = tab.render(container);
        await until(() => container.querySelector('.maestro-table') !== null);
        expect(container.textContent).toContain('The baseline is taken from the first turns (50); so far: 0.');

        buttonByText(container, 'Compare without the rules').click();
        await until(() => container.textContent?.includes('Characters without the rules: 9,000') === true);
        expect(container.textContent).toContain('33.3 % of the lore without rules');

        buttonByText(container, 'Check pack files').click();
        await until(() => container.textContent?.includes('Checked at') === true);
        expect(container.textContent).toContain('Seen for the first time (fingerprinted now): BunnyMo Core.');
        buttonByText(container, 'Check pack files').click();
        await until(() => container.textContent?.includes('checked: 1, changed: 0, missing: 0') === true);

        env.books.set('BunnyMo Core', '{"entries":{"1":{}}}');
        buttonByText(container, 'Take current files as the originals').click();
        await wait(20);
        buttonByText(container, 'Check pack files').click();
        await until(() => container.textContent?.includes('checked: 1, changed: 0') === true);

        buttonByText(container, 'Start the baseline again').click();
        await wait(20);
        expect(env.stand.chat.puts.some((put) => put.kind === 'metrics')).toBe(true);
    });

    it('says when there is nothing to compare', async () => {
        dispose = tab.render(container);
        await until(() => container.querySelector('.maestro-table') !== null);
        buttonByText(container, 'Compare without the rules').click();
        await until(() => container.textContent?.includes('The rules module is off') === true);
    });

    it('asks for a chat, and sleeps in group chats', async () => {
        env.stand.mock.chatId = undefined;
        await env.app.bus.emit('chat:changed', { chatId: null });
        dispose = tab.render(container);
        await until(() => container.textContent?.includes('Open a chat') === true);
        if (typeof dispose === 'function') dispose();

        env.stand.mock.chatId = 'chat-1';
        (env.app.host as unknown as { group: boolean }).group = true;
        await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        dispose = tab.render(container);
        await until(() => container.textContent?.includes('Maestro sleeps in group chats') === true);
    });

    it('shows module timings and data-loss warnings', async () => {
        env.logLines.push({
            at: env.wall.value + 1,
            level: 'error',
            scope: 'Maestro:M8',
            text: 'journal could not be saved after 3 attempts',
        });
        await env.generate({ during: () => service.record('rules.scan', 3) });
        service.record('places.capture', 2);
        dispose = tab.render(container);
        await until(() => container.textContent?.includes('Maestro:M8: journal could not be saved') === true);
        expect(container.textContent).toContain('Time of Maestro modules in a generation');
        expect(container.textContent).toContain('rules.scan');
        expect(container.textContent).toContain('Time of Maestro modules outside generations');
        expect(container.textContent).toContain('places.capture');
    });
});

describe('M21m module', () => {
    it('fits the registry, exposes MetricsApi and registers the tab', async () => {
        const env = createMetricsStand();
        const modules: MaestroModule[] = [metricsModule as unknown as MaestroModule];
        expect(modules.map((module) => [module.id, module.key, module.stage, module.titleKey])).toEqual([
            ['M21m', 'metrics', 4, 'm21m.title'],
        ]);
        expect(metricsModule.defaults()).toMatchObject({ windowTurns: 100, baselineTurns: 50 });
        expect(metricsModule.enabledByDefault).toBe(true);
        const started = await env.stand.start(metricsModule);
        const api = env.app.modules.api<MetricsApi>('metrics');
        expect(api).toBeTruthy();
        expect(env.stand.tabs.map((item) => item.id)).toContain(METRICS_TAB);
        expect(env.stand.styles.has('maestro-m21m')).toBe(true);
        expect(env.before.length).toBeGreaterThan(0);
        await env.generate();
        await wait(5);
        expect(api!.latency().byDevice.desktop.send.n + api!.latency().byDevice.phone.send.n).toBe(1);
        await started.stop();
        expect(env.stand.tabs.map((item) => item.id)).not.toContain(METRICS_TAB);
        expect(env.before).toHaveLength(0);
        expect(env.intercepts.size).toBe(0);
    });

    it('has every English string in Russian too', () => {
        const strings = metricsModule.i18n!;
        expect(Object.keys(strings.ru).sort()).toEqual(Object.keys(strings.en).sort());
        for (const value of Object.values(strings.ru)) expect(value.trim()).not.toBe('');
    });
});
