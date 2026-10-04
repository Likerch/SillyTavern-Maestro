import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES, createHost } from '../../src/host';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';
import { memoryLogger } from '../helpers/host-fakes';

let mock: StMock;

beforeEach(() => {
    mock = installStMock();
});

describe('createHost', () => {
    it('reads the live context on every call', () => {
        const host = createHost(memoryLogger());
        expect(host.ctx()).toBe(mock.context);
        expect(host.chatId()).toBe('chat-1');
        mock.chatId = undefined;
        expect(host.chatId()).toBeNull();
        expect(host.isGroupChat()).toBe(false);
        (mock.context as unknown as Record<string, unknown>)['groupId'] = 'g1';
        expect(host.isGroupChat()).toBe(true);
        expect(host.isChatCompletion()).toBe(true);
        (mock.context as unknown as Record<string, unknown>)['mainApi'] = 'novel';
        expect(host.isChatCompletion()).toBe(false);
    });

    it('install wraps fetch once, reads the version and registers built-in probes', async () => {
        const original = globalThis.fetch;
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            if (url === '/version')
                return new Response(JSON.stringify({ agent: 'SillyTavern:1.19.0:Cohee#1207', pkgVersion: '1.19.0' }));
            return original(input, init);
        };
        const unwrapped = globalThis.fetch;
        const host = createHost(memoryLogger());
        expect(host.version()).toBeUndefined();
        host.install();
        host.install();
        expect(globalThis.fetch).not.toBe(unwrapped);
        expect(await host.versionReady()).toBe('1.19.0');
        expect(host.version()).toBe('1.19.0');
        expect(host.caps.report().map((entry) => entry.id)).toEqual([...BUILTIN_CAPABILITIES]);

        const seen: string[] = [];
        host.fetchGate.beforeRequest(/api/, (url) => {
            seen.push(url);
        });
        await fetch('/api/ping');
        expect(seen).toEqual(['/api/ping']);

        host.dispose();
        expect(globalThis.fetch).toBe(unwrapped);
    });

    it('treats an unknown version as undefined', async () => {
        const host = createHost(memoryLogger());
        host.install();
        // The ST mock answers {} for /version.
        expect(await host.versionReady()).toBeUndefined();
        host.dispose();
    });

    it('dispose removes the listeners registered through host.events', async () => {
        const host = createHost(memoryLogger());
        host.install();
        let calls = 0;
        host.events.on('CHAT_CHANGED', () => {
            calls++;
        });
        await host.events.emit('CHAT_CHANGED');
        host.dispose();
        await mock.eventSource.emit('chat_id_changed');
        expect(calls).toBe(1);
    });
});
