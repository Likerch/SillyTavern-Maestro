import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatDocName, createChatStore, isEnvelope } from '../../src/core/chat-store';
import type { ChatEnvelope, MaestroChatStore } from '../../src/core/chat-store';
import { createFileStore } from '../../src/core/files';
import type { MaestroFileStore } from '../../src/core/files';
import { stableHash } from '../../src/domain/hash';
import { createTestHost, createTestLogger, storedJson, switchChat } from '../helpers/core-host';
import type { TestHost } from '../helpers/core-host';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

interface Notes {
    items: string[];
    count?: number;
}

const notes = (): Notes => ({ items: [] });

let mock: StMock;
let host: TestHost;
let files: MaestroFileStore;
let store: MaestroChatStore;

/** A second browser tab: own FileStore and ChatStore over the same server files. */
function otherTab(): MaestroChatStore {
    return createChatStore(host, createFileStore(host, createTestLogger()), createTestLogger(), {
        metadataSaveDelayMs: 0,
    });
}

function docName(chatId: string, kind: string): string {
    return chatDocName(files, chatId, kind);
}

beforeEach(() => {
    mock = installStMock();
    host = createTestHost(mock);
    files = createFileStore(host, createTestLogger());
    store = createChatStore(host, files, createTestLogger(), { metadataSaveDelayMs: 0 });
});

afterEach(() => {
    store.dispose();
    vi.useRealTimers();
});

describe('documents', () => {
    it('names files maestro-chat-<hash(chatId)>-<kind>.json', () => {
        expect(docName('chat-1', 'journal')).toBe(`maestro-chat-${stableHash('chat-1')}-journal.json`);
    });

    it('creates documents from defaults without writing', async () => {
        const doc = await store.get('notes', notes);
        expect(doc).toEqual({ items: [] });
        expect(mock.files.size).toBe(0);
    });

    it('writes an envelope with schema, version, time and tab', async () => {
        const doc = await store.get('notes', notes);
        doc.items.push('a');
        expect(await store.put('notes', doc)).toBe(true);
        const env = storedJson<ChatEnvelope<Notes>>(mock, docName('chat-1', 'notes'))!;
        expect(isEnvelope(env)).toBe(true);
        expect(env).toMatchObject({ schema: 1, version: 1, data: { items: ['a'] } });
        expect(typeof env.tabId).toBe('string');
        expect(env.updatedAt).toBeGreaterThan(0);

        expect(await store.put('notes', doc)).toBe(true);
        expect(storedJson<ChatEnvelope>(mock, docName('chat-1', 'notes'))!.version).toBe(2);
    });

    it('returns the cached object until the chat changes', async () => {
        const first = await store.get('notes', notes);
        expect(await store.get('notes', notes)).toBe(first);
    });

    it('deduplicates concurrent loads', async () => {
        const before = mock.requests.length;
        const [a, b] = await Promise.all([store.get('notes', notes), store.get('notes', notes)]);
        expect(a).toBe(b);
        expect(mock.requests.length - before).toBe(1);
    });

    it('fills missing top-level fields from defaults', async () => {
        mock.files.set(
            docName('chat-1', 'notes'),
            JSON.stringify({ schema: 1, version: 3, updatedAt: 1, tabId: 'x', data: { count: 2 } }),
        );
        expect(await store.get('notes', notes)).toEqual({ items: [], count: 2 });
    });

    it('starts from defaults when the file has no envelope', async () => {
        const log = createTestLogger();
        const local = createChatStore(host, files, log);
        mock.files.set(docName('chat-1', 'notes'), JSON.stringify({ items: ['raw'] }));
        expect(await local.get('notes', notes)).toEqual({ items: [] });
        expect(log.lines.some((line) => line.level === 'warn')).toBe(true);
        local.dispose();
    });

    it('does nothing without a chat', async () => {
        mock.chatId = undefined;
        expect(await store.get('notes', notes)).toEqual({ items: [] });
        expect(await store.put('notes', { items: ['x'] })).toBe(false);
        expect(mock.files.size).toBe(0);
    });

    it('reads documents of another chat with getFor', async () => {
        mock.files.set(
            docName('chat-7', 'notes'),
            JSON.stringify({ schema: 1, version: 1, updatedAt: 1, tabId: 'x', data: { items: ['seven'] } }),
        );
        expect(await store.getFor('chat-7', 'notes', notes)).toEqual({ items: ['seven'] });
    });
});

describe('compare-and-swap between tabs', () => {
    it('refuses a write over a newer version and reloads it', async () => {
        const mine = await store.get('notes', notes);
        mine.items.push('mine');
        expect(await store.put('notes', mine)).toBe(true);

        const other = otherTab();
        const theirs = await other.get('notes', notes);
        theirs.items.push('theirs');
        expect(await other.put('notes', theirs)).toBe(true);

        mine.items.push('stale');
        expect(await store.put('notes', mine)).toBe(false);
        expect(storedJson<ChatEnvelope<Notes>>(mock, docName('chat-1', 'notes'))!.data.items).toEqual([
            'mine',
            'theirs',
        ]);

        const fresh = await store.get('notes', notes);
        expect(fresh.items).toEqual(['mine', 'theirs']);
        fresh.items.push('retry');
        expect(await store.put('notes', fresh)).toBe(true);
        expect(storedJson<ChatEnvelope>(mock, docName('chat-1', 'notes'))!.version).toBe(3);
        other.dispose();
    });

    it('refuses a blind write over an existing file', async () => {
        const other = otherTab();
        await other.put('notes', { items: ['first'] });
        expect(await store.put('notes', { items: ['blind'] })).toBe(false);
        expect(await store.get('notes', notes)).toEqual({ items: ['first'] });
        other.dispose();
    });

    it('serialises writes of one tab', async () => {
        const doc = await store.get('notes', notes);
        const results = await Promise.all([store.put('notes', doc), store.put('notes', doc), store.put('notes', doc)]);
        expect(results).toEqual([true, true, true]);
        expect(storedJson<ChatEnvelope>(mock, docName('chat-1', 'notes'))!.version).toBe(3);
    });

    it('returns false when the write fails', async () => {
        const doc = await store.get('notes', notes);
        const original = globalThis.fetch;
        globalThis.fetch = async (input, init) =>
            String(input).includes('upload') ? new Response('no', { status: 500 }) : original(input, init);
        expect(await store.put('notes', doc)).toBe(false);
        globalThis.fetch = original;
    });
});

describe('migrations', () => {
    it('migrates old documents step by step and writes the new schema', async () => {
        mock.files.set(
            docName('chat-1', 'notes'),
            JSON.stringify({ schema: 1, version: 4, updatedAt: 1, tabId: 'x', data: { list: ['a'] } }),
        );
        store.migration('notes', 1, (doc) => ({ items: doc.list }));
        store.migration('notes', 2, (doc) => ({ ...doc, count: (doc.items as unknown[]).length }));
        const doc = await store.get('notes', notes);
        expect(doc).toEqual({ items: ['a'], count: 1 });
        expect(await store.put('notes', doc)).toBe(true);
        expect(storedJson<ChatEnvelope>(mock, docName('chat-1', 'notes'))).toMatchObject({ schema: 3, version: 5 });
    });

    it('starts new documents at the current schema', async () => {
        store.migration('notes', 1, (doc) => doc);
        await store.put('notes', await store.get('notes', notes));
        expect(storedJson<ChatEnvelope>(mock, docName('chat-1', 'notes'))!.schema).toBe(2);
    });

    it('does not overwrite a document written by a newer Maestro', async () => {
        mock.files.set(
            docName('chat-1', 'notes'),
            JSON.stringify({ schema: 9, version: 1, updatedAt: 1, tabId: 'x', data: { items: ['future'] } }),
        );
        const doc = await store.get('notes', notes);
        expect(await store.put('notes', doc)).toBe(false);
        expect(storedJson<ChatEnvelope>(mock, docName('chat-1', 'notes'))!.schema).toBe(9);
    });

    it('surfaces a failing migration instead of losing data', async () => {
        mock.files.set(
            docName('chat-1', 'notes'),
            JSON.stringify({ schema: 1, version: 1, updatedAt: 1, tabId: 'x', data: { items: [] } }),
        );
        store.migration('notes', 1, () => {
            throw new Error('bad');
        });
        await expect(store.get('notes', notes)).rejects.toThrow(/migration of notes/);
    });
});

describe('chat switches', () => {
    it('drops cached documents on CHAT_CHANGED', async () => {
        const first = await store.get('notes', notes);
        first.items.push('one');
        await store.put('notes', first);

        await switchChat(mock, 'chat-2');
        const second = await store.get('notes', notes);
        expect(second).toEqual({ items: [] });

        await switchChat(mock, 'chat-1');
        expect(await store.get('notes', notes)).toEqual({ items: ['one'] });
    });

    it('writes a document back to the chat it was read from', async () => {
        const doc = await store.get('notes', notes);
        await switchChat(mock, 'chat-2');
        doc.items.push('late');
        expect(await store.put('notes', doc)).toBe(true);
        expect(storedJson<ChatEnvelope<Notes>>(mock, docName('chat-1', 'notes'))!.data.items).toEqual(['late']);
        expect(mock.files.has(docName('chat-2', 'notes'))).toBe(false);
    });

    it('stops listening after dispose', () => {
        const listeners = () => mock.eventSource.events.get('chat_id_changed')?.length ?? 0;
        const before = listeners();
        store.dispose();
        expect(listeners()).toBe(before - 1);
    });
});

describe('pointers', () => {
    it('keeps small values in chatMetadata.maestro and saves metadata', async () => {
        const save = vi.fn(async () => {});
        mock.context.saveMetadata = save;
        await store.setPointer('counter', 3);
        expect(store.pointer<number>('counter')).toBe(3);
        expect(mock.chatMetadata.maestro).toEqual({ schema: 1, kinds: [], pointers: { counter: 3 } });
        expect(save).toHaveBeenCalledTimes(1);
        await store.setPointer('counter', undefined);
        expect(store.pointer('counter')).toBeUndefined();
    });

    it('always reads the live chatMetadata object', async () => {
        await store.setPointer('counter', 1);
        mock.chatMetadata = {};
        expect(store.pointer('counter')).toBeUndefined();
        await store.setPointer('counter', 2);
        expect((mock.chatMetadata.maestro as { pointers: Record<string, unknown> }).pointers.counter).toBe(2);
    });

    it('debounces metadata saves', async () => {
        vi.useFakeTimers();
        const local = createChatStore(host, files, createTestLogger(), { metadataSaveDelayMs: 500 });
        const save = vi.fn(async () => {});
        mock.context.saveMetadata = save;
        const done = Promise.all([local.setPointer('a', 1), local.setPointer('b', 2), local.setPointer('c', 3)]);
        await vi.advanceTimersByTimeAsync(499);
        expect(save).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(save).toHaveBeenCalledTimes(1);
        local.dispose();
    });

    it('drops a pending save when the chat changed meanwhile', async () => {
        vi.useFakeTimers();
        const local = createChatStore(host, files, createTestLogger(), { metadataSaveDelayMs: 500 });
        const save = vi.fn(async () => {});
        mock.context.saveMetadata = save;
        const done = local.setPointer('a', 1);
        await switchChat(mock, 'chat-2');
        await vi.advanceTimersByTimeAsync(500);
        await done;
        expect(save).not.toHaveBeenCalled();
        local.dispose();
    });

    it('ignores pointers without a chat', async () => {
        mock.chatId = undefined;
        await store.setPointer('a', 1);
        expect(mock.chatMetadata.maestro).toBeUndefined();
    });

    it('ignores malformed metadata', () => {
        mock.chatMetadata.maestro = 'garbage';
        expect(store.pointer('a')).toBeUndefined();
    });
});

describe('export and import', () => {
    it('indexes written kinds per chat and globally', async () => {
        await store.put('notes', { items: ['x'] });
        await store.put('extra', { items: [] });
        expect((mock.chatMetadata.maestro as { kinds: string[] }).kinds).toEqual(['notes', 'extra']);
        await vi.waitFor(() => {
            expect(storedJson<{ kinds: string[] }>(mock, 'maestro-chat-kinds.json')?.kinds).toEqual(['extra', 'notes']);
        });
    });

    it('bundles every document of a chat and imports it into another', async () => {
        await store.put('notes', { items: ['a', 'b'] });
        await store.put('extra', { items: ['c'] });
        await store.setPointer('counter', 5);
        const bundle = await store.exportChat('chat-1');
        expect(bundle).toMatchObject({
            format: 'maestro-chat',
            formatVersion: 1,
            chatId: 'chat-1',
            pointers: { counter: 5 },
        });
        expect(Object.keys(bundle.docs as object).sort()).toEqual(['extra', 'notes']);

        await store.importChat('chat-9', JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>);
        expect(await store.getFor('chat-9', 'notes', notes)).toEqual({ items: ['a', 'b'] });
        expect(await store.getFor('chat-9', 'extra', notes)).toEqual({ items: ['c'] });
    });

    it('exports documents of a chat that is not open (global kinds index)', async () => {
        await store.put('notes', { items: ['old'] });
        await vi.waitFor(() => expect(mock.files.has('maestro-chat-kinds.json')).toBe(true));
        await switchChat(mock, 'chat-2');
        const fresh = createChatStore(host, createFileStore(host, createTestLogger()), createTestLogger());
        const bundle = await fresh.exportChat('chat-1');
        expect(Object.keys(bundle.docs as object)).toEqual(['notes']);
        expect(bundle.pointers).toBeUndefined();
        fresh.dispose();
    });

    it('imports into the open chat: pointers, kinds index, version above the existing one', async () => {
        await store.put('notes', { items: ['local'] });
        await store.put('notes', await store.get('notes', notes));
        const bundle = {
            format: 'maestro-chat',
            formatVersion: 1,
            chatId: 'elsewhere',
            exportedAt: 1,
            pointers: { imported: true },
            docs: { notes: { schema: 1, version: 1, updatedAt: 1, tabId: 'x', data: { items: ['imported'] } } },
        };
        await store.importChat('chat-1', bundle);
        expect(await store.get('notes', notes)).toEqual({ items: ['imported'] });
        expect(storedJson<ChatEnvelope>(mock, docName('chat-1', 'notes'))!.version).toBe(3);
        expect(store.pointer('imported')).toBe(true);
        const doc = await store.get('notes', notes);
        expect(await store.put('notes', doc)).toBe(true);
    });

    it('rejects foreign bundles and skips broken documents', async () => {
        await expect(store.importChat('chat-1', { format: 'other' })).rejects.toThrow(/bundle/);
        await store.importChat('chat-1', { format: 'maestro-chat', docs: { bad: { nope: 1 } } });
        expect(mock.files.has(docName('chat-1', 'bad'))).toBe(false);
    });
});

describe('deleted chats (plan-2 §9)', () => {
    it('removes every document of a chat ST deleted, of every kind, and nothing of other chats', async () => {
        await store.put('notes', { items: ['old story'] });
        await store.put('world', { aliases: { Фея: 'character:офелия' } });
        await vi.waitFor(() => expect(mock.files.has('maestro-chat-kinds.json')).toBe(true));
        await switchChat(mock, 'chat-2');
        await store.put('notes', { items: ['other chat'] });
        await mock.eventSource.emit('chat_deleted', 'chat-1');
        await vi.waitFor(() => expect(mock.files.has(docName('chat-1', 'world'))).toBe(false));
        expect(mock.files.has(docName('chat-1', 'notes'))).toBe(false);
        expect(mock.files.has(docName('chat-2', 'notes'))).toBe(true);
        expect(mock.files.has('maestro-chat-kinds.json')).toBe(true);
        // A new chat that gets the same id starts empty.
        await switchChat(mock, 'chat-1');
        expect(await store.get('notes', notes)).toEqual({ items: [] });
    });

    it('group chats too; the open chat and unknown ids are left alone', async () => {
        await store.put('notes', { items: ['open'] });
        expect(await store.removeChat('chat-1')).toBe(0);
        expect(mock.files.has(docName('chat-1', 'notes'))).toBe(true);
        expect(await store.removeChat('never-written')).toBe(0);
        await switchChat(mock, 'group-chat-2');
        await store.put('notes', { items: ['group'] });
        await switchChat(mock, 'chat-1');
        await mock.eventSource.emit('group_chat_deleted', 'group-chat-2');
        await vi.waitFor(() => expect(mock.files.has(docName('group-chat-2', 'notes'))).toBe(false));
        await mock.eventSource.emit('chat_deleted', 42);
        expect(mock.files.has(docName('chat-1', 'notes'))).toBe(true);
    });
});
