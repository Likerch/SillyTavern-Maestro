// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardianModule } from '../../../src/features/guardian';
import type { GuardianService } from '../../../src/features/guardian/service';
import { GUARDIAN_TAB } from '../../../src/features/guardian/view';
import { installSettingsServer, trackedStack } from '../../helpers/guardian-env';
import type { SettingsServer, TrackedStack } from '../../helpers/guardian-env';
import { createFeatureEnv, flush } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';

let env: FeatureEnv;
let server: SettingsServer;
let stack: TrackedStack;
let stop: () => Promise<void>;
let container: HTMLElement;
let unmount: (() => void) | void;

function buttons(label: string): HTMLButtonElement[] {
    return [...container.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);
}

beforeEach(async () => {
    env = await createFeatureEnv();
    server = installSettingsServer(env);
    stack = trackedStack(env);
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
    it('shows the tab state, the baseline, what it covers and no drift', () => {
        expect(container.textContent).toContain('This tab is up to date');
        expect(container.textContent).toContain('first start');
        expect(container.textContent).toContain('The baseline keeps system settings only');
        expect(container.textContent).toContain('Everything matches the baseline');
    });

    it('lists drift and restores one item', async () => {
        stack.live.openai_max_tokens = 1000;
        (env.apis.get('guardian') as GuardianService).emit();
        await flush();
        expect(container.textContent).toContain('Connection · reply length');
        buttons('Restore')[0]!.click();
        await flush();
        expect(stack.live.openai_max_tokens).toBe(300);
        // A reply to his click: always shown.
        expect(env.ui.notices.at(-1)).toMatchObject({
            text: 'Put settings back to the baseline: 1.',
            options: { urgent: true },
        });
        expect(container.textContent).toContain('Everything matches the baseline');
    });

    it('keeps a change as the new baseline', async () => {
        (env.mock.extensionSettings.qvink_memory as Record<string, unknown>).notify_on_profile_switch = true;
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
