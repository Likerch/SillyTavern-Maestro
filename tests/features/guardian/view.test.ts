// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardianModule } from '../../../src/features/guardian';
import type { GuardianService } from '../../../src/features/guardian/service';
import { GUARDIAN_TAB } from '../../../src/features/guardian/view';
import { installSettingsServer, trackedStack } from '../../helpers/guardian-env';
import type { SettingsServer } from '../../helpers/guardian-env';
import { createFeatureEnv, flush } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';

let env: FeatureEnv;
let server: SettingsServer;
let stop: () => Promise<void>;
let container: HTMLElement;
let unmount: (() => void) | void;

function buttons(label: string): HTMLButtonElement[] {
    return [...container.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);
}

beforeEach(async () => {
    env = await createFeatureEnv();
    server = installSettingsServer(env);
    trackedStack(env);
    env.leader.value = false;
    stop = await env.start(guardianModule);
    await flush();
    container = document.createElement('div');
    document.body.append(container);
    const tab = env.ui.tabs.find((item) => item.id === GUARDIAN_TAB)!;
    expect(tab.titleKey).toBe('m4.tab');
    expect(tab.order).toBe(72);
    unmount = tab.render(container);
    await flush();
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    await stop();
    document.body.innerHTML = '';
});

describe('guardian tab', () => {
    it('shows the tab state, the baseline and no drift', () => {
        expect(container.textContent).toContain('This tab is up to date');
        expect(container.textContent).toContain('first start');
        expect(container.textContent).toContain('Everything matches the baseline');
    });

    it('lists drift and restores one item', async () => {
        (env.mock.extensionSettings.qvink_memory as Record<string, unknown>).auto_summarize = false;
        (env.apis.get('guardian') as GuardianService).emit();
        await flush();
        expect(container.textContent).toContain('Qvink · auto_summarize');
        buttons('Restore')[0]!.click();
        await flush();
        expect((env.mock.extensionSettings.qvink_memory as Record<string, unknown>).auto_summarize).toBe(true);
        expect(env.ui.notices.at(-1)?.text).toContain('Settings restored: 1');
        expect(container.textContent).toContain('Everything matches the baseline');
    });

    it('keeps a change as the new baseline', async () => {
        (env.mock.extensionSettings.qvink_memory as Record<string, unknown>).prompt = 'New';
        (env.apis.get('guardian') as GuardianService).emit();
        await flush();
        buttons('Keep all as the baseline')[0]!.click();
        await flush();
        expect(container.textContent).toContain('Everything matches the baseline');
    });

    it('takes a new baseline and checks the tab on demand', async () => {
        buttons('Take baseline')[0]!.click();
        await flush();
        expect(container.textContent).toContain('by hand');
        buttons('Check now')[0]!.click();
        await flush();
        expect(server.gets).toBe(1);
        expect(container.textContent).toContain('Last check');
    });
});
