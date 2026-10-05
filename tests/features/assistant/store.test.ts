import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../../../src/features/assistant/api';
import {
    ASSISTANT_DOC,
    AssistantStore,
    MAX_MESSAGES,
    STORED_ARG_CHARS,
    STORED_VALUE_CHARS,
    compactArgs,
    compactValue,
    normalizeAssistantDoc,
} from '../../../src/features/assistant/store';
import type { AssistantDoc } from '../../../src/features/assistant/store';
import { createAssistantEnv, flush } from './env';

function message(id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
    return { id, role: 'user', text: id, at: 1, ...extra };
}

describe('assistant store', () => {
    it('keeps one conversation per chat and reloads on a chat switch', async () => {
        const env = createAssistantEnv();
        const store = new AssistantStore(env.app, env.log);
        await store.mutate((doc) => void doc.messages.push(message('a')));
        env.state.chatId = 'chat-2';
        store.reset();
        await flush();
        expect(store.current().messages).toEqual([]);
        await store.mutate((doc) => void doc.messages.push(message('b')));
        env.state.chatId = 'chat-1';
        store.reset();
        await flush();
        expect(store.current().messages.map((item) => item.id)).toEqual(['a']);
        expect(env.chat.stored<AssistantDoc>('chat-2', ASSISTANT_DOC)?.messages.map((item) => item.id)).toEqual(['b']);
    });

    it('drops a write meant for another chat', async () => {
        const env = createAssistantEnv();
        const store = new AssistantStore(env.app, env.log);
        await store.mutate((doc) => void doc.messages.push(message('late')), 'chat-0');
        expect(env.chat.puts).toBe(0);
    });

    it('clear() empties the messages but keeps the rate-limit stamps', async () => {
        const env = createAssistantEnv();
        const store = new AssistantStore(env.app, env.log);
        const now = Date.now();
        await store.mutate((doc) => {
            doc.messages.push(message('a'), message('b'));
            doc.writes.push(now);
        });
        await store.clear();
        expect(env.chat.stored<AssistantDoc>('chat-1', ASSISTANT_DOC)).toEqual({ messages: [], writes: [now] });
    });

    it('keeps at most 200 messages and drops write stamps older than an hour', async () => {
        const env = createAssistantEnv();
        const store = new AssistantStore(env.app, env.log);
        await store.mutate((doc) => {
            for (let i = 0; i < MAX_MESSAGES + 15; i++) doc.messages.push(message(`m${i}`));
            doc.writes.push(Date.now() - 2 * 3_600_000, Date.now());
        });
        const stored = env.chat.stored<AssistantDoc>('chat-1', ASSISTANT_DOC)!;
        expect(stored.messages).toHaveLength(MAX_MESSAGES);
        expect(stored.messages[0]?.id).toBe('m15');
        expect(stored.writes).toHaveLength(1);
    });

    it('retries a failed write without duplicating the change', async () => {
        const env = createAssistantEnv();
        const store = new AssistantStore(env.app, env.log);
        env.chat.failPuts = 1;
        await store.mutate((doc) => {
            if (!doc.messages.some((item) => item.id === 'a')) doc.messages.push(message('a'));
        });
        expect(env.chat.puts).toBe(2);
        expect(env.chat.stored<AssistantDoc>('chat-1', ASSISTANT_DOC)?.messages).toHaveLength(1);
        env.chat.failPuts = 5;
        await store.mutate((doc) => void doc.messages.push(message('b')));
        expect(env.log.lines.some((line) => line.level === 'warn')).toBe(true);
    });

    it('lives in memory without a chat', async () => {
        const env = createAssistantEnv({ chatId: null });
        const store = new AssistantStore(env.app, env.log);
        let changes = 0;
        store.onChange(() => changes++);
        await store.mutate((doc) => void doc.messages.push(message('a')));
        expect(store.current().messages).toHaveLength(1);
        expect(await store.load()).toBe(store.current());
        expect(env.chat.puts).toBe(0);
        expect(changes).toBe(1);
    });

    it('closes calls a reload interrupted, but not the ones this tab still runs', async () => {
        const env = createAssistantEnv();
        env.chat.saved.set(
            `chat-1|${ASSISTANT_DOC}`,
            JSON.stringify({
                messages: [
                    {
                        id: 'm',
                        role: 'assistant',
                        text: '',
                        at: 1,
                        toolCalls: [
                            { id: 'r', name: 'read', args: {}, status: 'running' },
                            { id: 'w', name: 'write', args: {}, status: 'waiting', before: 1, after: 2 },
                            { id: 'live', name: 'write', args: {}, status: 'waiting' },
                        ],
                    },
                ],
                writes: [],
            }),
        );
        const store = new AssistantStore(env.app, env.log, () => new Set(['live']));
        const doc = await store.load();
        expect(doc.messages[0]?.toolCalls?.map((call) => [call.id, call.status, call.error])).toEqual([
            ['r', 'error', 'interrupted'],
            ['w', 'declined', undefined],
            ['live', 'waiting', undefined],
        ]);
        expect(store.current()).toBe(doc);
    });

    it('normalises junk documents', () => {
        expect(normalizeAssistantDoc(null)).toEqual({ messages: [], writes: [] });
        const doc = normalizeAssistantDoc({
            messages: [
                {
                    id: 'ok',
                    role: 'assistant',
                    text: 'hi',
                    at: 5,
                    costUsd: 0.1,
                    toolCalls: [{ id: 'c', name: 'x' }, 7],
                },
                { id: 'bad-role', role: 'system', text: 'x' },
                { role: 'user', text: 'no id' },
                { id: 'n', role: 'notice', costUsd: Number.NaN, toolCalls: [] },
                'junk',
            ],
            writes: [1, 'x', Number.POSITIVE_INFINITY],
        });
        expect(doc.messages).toEqual([
            {
                id: 'ok',
                role: 'assistant',
                text: 'hi',
                at: 5,
                costUsd: 0.1,
                toolCalls: [{ id: 'c', name: 'x', args: {}, status: 'error' }],
            },
            { id: 'n', role: 'notice', text: '', at: 0 },
        ]);
        expect(doc.writes).toEqual([1]);
        const full = normalizeAssistantDoc({
            messages: [
                {
                    id: 'f',
                    role: 'assistant',
                    text: '',
                    at: 1,
                    toolCalls: [
                        {
                            id: 'c',
                            name: 'x',
                            args: { a: 1 },
                            status: 'applied',
                            summary: 's',
                            target: 't',
                            before: null,
                            after: [1],
                            error: 'e',
                            result: 'r',
                            untrusted: true,
                        },
                    ],
                },
            ],
        });
        expect(full.messages[0]?.toolCalls?.[0]).toEqual({
            id: 'c',
            name: 'x',
            args: { a: 1 },
            status: 'applied',
            summary: 's',
            target: 't',
            before: null,
            after: [1],
            error: 'e',
            result: 'r',
            untrusted: true,
        });
    });

    it('keeps tool records compact', () => {
        const args = compactArgs({ text: 'x'.repeat(5000), small: { a: 1 }, big: { list: 'y'.repeat(2000) }, n: 3 });
        expect((args['text'] as string).length).toBeLessThan(STORED_ARG_CHARS + 40);
        expect(args['small']).toEqual({ a: 1 });
        expect(typeof args['big']).toBe('string');
        expect(args['n']).toBe(3);
        expect(compactValue(undefined)).toBeUndefined();
        expect(compactValue({ a: 1 })).toEqual({ a: 1 });
        expect((compactValue('z'.repeat(10_000)) as string).length).toBeLessThan(STORED_VALUE_CHARS + 40);
        expect(typeof compactValue({ text: 'z'.repeat(10_000) })).toBe('string');
    });
});
