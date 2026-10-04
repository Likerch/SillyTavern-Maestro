// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentTabId } from '../../../src/core/files';
import { guardianModule } from '../../../src/features/guardian';
import type { GuardianApi } from '../../../src/features/guardian/api';
import { BANNER_ID } from '../../../src/features/guardian/banner';
import { HOLD_LIMIT, TabGuard } from '../../../src/features/guardian/tab-guard';
import type { TabGuardEnv } from '../../../src/features/guardian/tab-guard';
import type { FetchGate } from '../../../src/shared/contracts';
import { createTestLogger } from '../../helpers/core-host';
import { installSettingsServer, otherTabSaves, stSave } from '../../helpers/guardian-env';
import type { SettingsServer } from '../../helpers/guardian-env';
import { createFeatureEnv, flush } from '../../helpers/medic-app';
import type { FeatureEnv } from '../../helpers/medic-app';

type Dict = Record<string, unknown>;

let env: FeatureEnv;
let server: SettingsServer;
let stop: () => Promise<void>;
let visibility: DocumentVisibilityState;

function api(): GuardianApi {
    return env.apis.get('guardian') as GuardianApi;
}

function saves(path = '/api/settings/save'): number {
    return env.server.requests.filter((request) => request.url.includes(path)).length;
}

function hide(): void {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
}

function show(): void {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
}

function banner(): HTMLElement | null {
    return document.getElementById(BANNER_ID);
}

function bannerButton(index: number): HTMLButtonElement {
    return banner()!.querySelectorAll('button')[index] as HTMLButtonElement;
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_700_000_000_000);
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    env = await createFeatureEnv();
    (env.mock.context as unknown as Dict).powerUserSettings = { theme: 'mine' };
    server = installSettingsServer(env, { extension_settings: {}, power_user: { theme: 'mine' } });
    stop = await env.start(guardianModule);
    await flush();
});

afterEach(async () => {
    await stop();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('stamp', () => {
    it('gives every save of this tab its own stamp', async () => {
        const slice = env.settings.module<{ stamp?: { tabId: string; seq: number } }>('guardian');
        expect(slice.stamp).toMatchObject({ tabId: currentTabId(), seq: 1 });
        const response = await stSave(env);
        expect(response.ok).toBe(true);
        expect(slice.stamp).toMatchObject({ seq: 2 });
        const stored = server.settings.extension_settings as Dict;
        expect((stored.maestro as { modules: { guardian: { stamp: Dict } } }).modules.guardian.stamp).toMatchObject({
            tabId: currentTabId(),
            seq: 1,
        });
        expect(server.gets).toBe(0);
        expect(api().tabState()).toBe('fresh');
    });
});

describe('returning to the tab', () => {
    it('checks the server at most once a minute and stays fresh when nobody saved', async () => {
        hide();
        show();
        await flush();
        expect(server.gets).toBe(1);
        window.dispatchEvent(new Event('focus'));
        await flush();
        expect(server.gets).toBe(1);
        vi.setSystemTime(Date.now() + 61_000);
        window.dispatchEvent(new Event('focus'));
        await flush();
        expect(server.gets).toBe(2);
        expect(api().tabState()).toBe('fresh');
    });

    it('checks before the first save after the tab was hidden', async () => {
        await stSave(env);
        hide();
        await stSave(env);
        expect(server.gets).toBe(1);
        expect(saves()).toBe(2);
        await stSave(env);
        expect(server.gets).toBe(1);
    });
});

describe('stale tab', () => {
    async function goStale(): Promise<void> {
        await stSave(env);
        otherTabSaves(server);
        hide();
    }

    it('holds saves, shows the banner and lets them go on "save anyway"', async () => {
        await goStale();
        let done = false;
        const pending = stSave(env).then((response) => {
            done = true;
            return response;
        });
        await flush();
        expect(done).toBe(false);
        expect(saves()).toBe(1);
        expect(api().tabState()).toBe('stale');
        const node = banner();
        expect(node?.textContent).toContain('This tab is out of date');
        expect(node?.textContent).toContain('power_user.theme');
        expect(node?.textContent).toContain('settings — 1');

        bannerButton(1).click();
        const response = await pending;
        expect(response.ok).toBe(true);
        expect(saves()).toBe(2);
        expect(banner()).toBeNull();
        expect(api().tabState()).toBe('fresh');
        // Our save is on the server now: the next check finds the tab fresh.
        hide();
        await stSave(env);
        expect(api().tabState()).toBe('fresh');
    });

    it('holds presets and lorebooks too, but not other requests', async () => {
        await goStale();
        const settings = stSave(env);
        await flush();
        const preset = env.stFetch('/api/presets/save', { method: 'POST', body: '{}' });
        const book = env.stFetch('/api/worldinfo/edit', { method: 'POST', body: '{}' });
        const chat = await env.stFetch('/api/chats/save', { method: 'POST', body: '{}' });
        await flush();
        expect(chat.ok).toBe(true);
        expect(saves('/api/presets/save')).toBe(0);
        expect(saves('/api/worldinfo/edit')).toBe(0);
        expect(banner()?.textContent).toContain('presets — 1');
        await stop();
        // Switching the module off releases everything it held.
        await Promise.all([settings, preset, book]);
        expect(saves()).toBe(2);
        expect(saves('/api/presets/save')).toBe(1);
        expect(saves('/api/worldinfo/edit')).toBe(1);
        expect(banner()).toBeNull();
        stop = async () => {};
    });

    it('refuses the oldest held save with a non-ok response beyond the limit', async () => {
        await goStale();
        const first = stSave(env);
        const rest = Array.from({ length: HOLD_LIMIT }, () => stSave(env));
        const response = await first;
        expect(response.ok).toBe(false);
        expect(response.status).toBe(409);
        expect(banner()?.textContent).toContain('Not saved');
        bannerButton(1).click();
        await Promise.all(rest);
        expect(saves()).toBe(1 + HOLD_LIMIT);
    });

    it('does not block saves when the check fails', async () => {
        await stSave(env);
        server.fail = true;
        hide();
        const response = await stSave(env);
        expect(response.ok).toBe(true);
        expect(api().tabState()).toBe('fresh');
    });
});

describe('TabGuard edge cases', () => {
    function fakeGate() {
        const before: ((url: string, init?: RequestInit) => unknown)[] = [];
        const after: ((url: string, response: Response) => void)[] = [];
        const gate: FetchGate = {
            beforeRequest: (_match, hook) => {
                before.push(hook);
                return () => before.splice(before.indexOf(hook), 1);
            },
            afterResponse: (_match, hook) => {
                after.push(hook);
                return () => after.splice(after.indexOf(hook), 1);
            },
        };
        return { gate, before, after };
    }

    function guardEnv(overrides: Partial<TabGuardEnv> = {}): TabGuardEnv {
        const slice: Dict = { autoCheckMinutes: 10, stamp: { tabId: 'me', seq: 4, at: 1 } };
        return {
            gate: fakeGate().gate,
            stampPath: 'extension_settings.maestro.modules.guardian.stamp',
            myTabId: 'me',
            slice: () => slice as never,
            fetchServer: async () => null,
            local: () => ({}),
            now: () => Date.now(),
            log: createTestLogger(),
            document: null,
            window: null,
            onChange: () => {},
            ...overrides,
        };
    }

    it('continues its own seq after a restart in the same page', () => {
        const options = guardEnv();
        new TabGuard(options);
        expect(options.slice().stamp).toMatchObject({ tabId: 'me', seq: 5 });
    });

    it('stays fresh when its own save lands during a check', async () => {
        const { gate, after } = fakeGate();
        let answer: (text: string) => void = () => {};
        const options = guardEnv({
            gate,
            fetchServer: () => new Promise<string>((resolve) => (answer = resolve)),
        });
        const guard = new TabGuard(options);
        guard.install();
        const check = guard.check();
        expect(guard.state()).toBe('checking');
        after[0]!('/api/settings/save', new Response('{}', { status: 200 }));
        answer(
            JSON.stringify({
                extension_settings: { maestro: { modules: { guardian: { stamp: { tabId: 'x', seq: 1 } } } } },
            }),
        );
        await check;
        expect(guard.state()).toBe('fresh');
        guard.dispose();
    });

    it('keeps a stale tab stale when a re-check fails, and ignores failed saves', async () => {
        const { gate, after } = fakeGate();
        let text: string | null = JSON.stringify({
            extension_settings: { maestro: { modules: { guardian: { stamp: { tabId: 'x', seq: 1 } } } } },
        });
        const guard = new TabGuard(guardEnv({ gate, fetchServer: async () => text }));
        guard.install();
        await guard.check();
        expect(guard.state()).toBe('stale');
        text = 'not json';
        await guard.check();
        expect(guard.state()).toBe('stale');
        after[0]!('/api/settings/save', new Response('{}', { status: 500 }));
        expect(guard.state()).toBe('stale');
        expect(guard.info().server).toMatchObject({ tabId: 'x' });
        guard.dispose();
    });
});
