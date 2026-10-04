// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qualityModule } from '../../../src/features/quality';
import type { QualityApi } from '../../../src/features/quality';
import { qualityTab } from '../../../src/features/quality/view';
import { readQualitySettings } from '../../../src/features/quality/settings';
import type { QualitySettings } from '../../../src/features/quality/settings';
import { basicChat, createQualityStand, defect, settle, sleep } from './helpers';
import type { QualityStand } from './helpers';

vi.mock('../../../src/domain/quality-checks', async () => (await import('./fake-checks')).fakeChecksModule);

let env: QualityStand;
let container: HTMLElement;
let cleanup: (() => void) | void;

beforeEach(() => {
    env = createQualityStand();
    basicChat(env);
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(async () => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    container.remove();
    await env.stop();
});

function render(): void {
    const service = env.service();
    const tab = qualityTab(env.app, service, () =>
        readQualitySettings(env.app.settings.module<Partial<QualitySettings>>('quality')),
    );
    expect(tab).toMatchObject({ id: 'quality', titleKey: 'm12.tab', order: 52 });
    cleanup = tab.render(container);
}

const buttons = (label: string) =>
    [...container.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);

describe('quality tab', () => {
    it('lists the last verdicts with defects, quotes and actions', async () => {
        env.defects(defect('refusal', { quote: 'I cannot do that' }));
        env.start();
        await env.reply(2);
        render();
        const text = container.textContent ?? '';
        expect(text).toContain('Message #3, swipe 1');
        expect(text).toContain('waiting for you');
        expect(text).toContain('refusal');
        expect(text).toContain('«I cannot do that»');
        expect(buttons('Redo')).toHaveLength(1);
        expect(buttons('Check again')).toHaveLength(1);

        buttons('Not a defect')[0]!.click();
        await sleep(80);
        expect(container.textContent).toContain('all good');
        expect(container.textContent).toContain('not a defect');
    });

    it('shows the action per kind; the boundary has no «Auto»', async () => {
        const service = env.start();
        render();
        const selects = [...container.querySelectorAll('select')];
        expect(selects).toHaveLength(11);
        const boundary = selects.find((node) => node.getAttribute('aria-label') === 'content boundary')!;
        expect([...boundary.options].map((option) => option.value)).toEqual(['off', 'notify']);
        const refusal = selects.find((node) => node.getAttribute('aria-label') === 'refusal')!;
        expect(refusal.value).toBe('notify');
        refusal.value = 'auto';
        refusal.dispatchEvent(new Event('change'));
        expect(service.configuredAction('refusal')).toBe('auto');
        expect(env.core.autonomy['quality.refusal']).toBe('auto');
    });

    it('shows the statistics with the false-positive rate', async () => {
        env.defects(defect('repetition'));
        const service = env.start();
        await env.reply(2);
        await service.dismiss(2, 'repetition');
        render();
        await sleep(80);
        const rows = [...container.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
        const repetition = rows.find((row) => row.startsWith('repetition'))!;
        expect(repetition).toContain('100 %');
    });

    it('edits, validates and saves the boundary rules', async () => {
        const service = env.start();
        render();
        buttons('Add a rule')[0]!.click();
        const areas = [...container.querySelectorAll<HTMLTextAreaElement>('.maestro-m12-rule textarea')];
        expect(areas).toHaveLength(2);
        const area = areas[1]!;
        area.value = 'both:knife&&\n(bad';
        area.dispatchEvent(new Event('input'));
        expect(container.querySelector('.maestro-m12-error')?.parentElement).toBeTruthy();
        expect(container.textContent).toContain('Not a valid pattern');
        buttons('Save the rules')[0]!.click();
        await settle(10);
        expect(env.notices.at(-1)?.text).toContain('broken pattern');
        expect(service.boundary()).toHaveLength(1);

        area.value = 'knife\nблад';
        area.dispatchEvent(new Event('input'));
        buttons('Save the rules')[0]!.click();
        await settle(10);
        expect(service.boundary()).toHaveLength(2);
        expect(service.boundary()[1]!.patterns).toEqual(['knife', 'блад']);

        buttons('Back to the default')[0]!.click();
        expect(container.querySelectorAll('.maestro-m12-rule')).toHaveLength(1);
    });

    it('runs the test mode on a pasted text without acting', async () => {
        env.defects(defect('boundary', { quote: 'bad words', confidence: 0.6 }));
        env.start();
        render();
        const area = container.querySelector<HTMLTextAreaElement>('.maestro-m12-test textarea')!;
        area.value = 'A text with bad words';
        area.dispatchEvent(new Event('input'));
        buttons('Check the text')[0]!.click();
        expect(container.textContent).toContain('content boundary');
        expect(container.textContent).toContain('the judge would be asked');
        expect(env.badges).toHaveLength(0);
    });

    it('shows the economy banner and the NAI Studio state', () => {
        env.core.mode = 'economy';
        env.start();
        render();
        expect(container.textContent).toContain('«Economy» mode');
        expect(container.textContent).toContain('NAI Studio waits for the check');
    });
});

describe('module', () => {
    it('exposes the API, adds the tab, the style and the profile task, and cleans up', async () => {
        const started = await env.stand.start(qualityModule);
        const api = env.app.modules.api<QualityApi>('quality');
        expect(api).toBeDefined();
        expect(typeof api!.gate).toBe('function');
        expect(env.tabs.map((tab) => tab.id)).toEqual(['quality']);
        expect(env.stand.styles.has('maestro-m12')).toBe(true);
        expect(env.producers.has('quality.fix')).toBe(true);
        await started.stop();
        expect(env.tabs).toHaveLength(0);
        expect(env.producers.has('quality.fix')).toBe(false);
        expect(env.nai.gate).toBeNull();
    });
});
