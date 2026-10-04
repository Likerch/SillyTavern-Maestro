import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatDocName, createChatStore } from '../../src/core/chat-store';
import type { ChatEnvelope, MaestroChatStore } from '../../src/core/chat-store';
import { createFileStore } from '../../src/core/files';
import { createJournal, JOURNAL_KIND } from '../../src/core/journal';
import type { JournalService } from '../../src/core/journal';
import type { JournalAction, JournalChange, JournalRecord } from '../../src/shared/contracts';
import { createTestHost, createTestLogger, storedJson, switchChat } from '../helpers/core-host';
import type { TestHost } from '../helpers/core-host';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

let mock: StMock;
let host: TestHost;
let chat: MaestroChatStore;
let journal: JournalService;

function action(overrides: Partial<JournalAction> = {}): JournalAction {
    return {
        module: 'M1',
        kind: 'canon.fact',
        summary: 'Added a fact',
        changes: [{ target: 'flag', ref: { name: 'a' }, before: null, after: 1 }],
        ...overrides,
    };
}

function storedRecords(chatId = 'chat-1'): JournalRecord[] {
    const files = createFileStore(host, createTestLogger());
    return (
        storedJson<ChatEnvelope<{ records: JournalRecord[] }>>(mock, chatDocName(files, chatId, JOURNAL_KIND))?.data
            .records ?? []
    );
}

beforeEach(() => {
    mock = installStMock();
    host = createTestHost(mock);
    chat = createChatStore(host, createFileStore(host, createTestLogger()), createTestLogger(), {
        metadataSaveDelayMs: 0,
    });
    journal = createJournal({ host, chat, log: createTestLogger() });
});

afterEach(() => {
    chat.dispose();
    vi.useRealTimers();
});

describe('journal', () => {
    it('records actions in the chat document and lists them newest first', async () => {
        const first = await journal.record(action({ summary: 'one' }));
        const second = await journal.record(action({ summary: 'two', module: 'M2' }));
        expect(first).not.toBe(second);
        expect(storedRecords().map((record) => record.id)).toEqual([first, second]);
        expect(storedRecords()[0]).toMatchObject({ chatId: 'chat-1', summary: 'one' });
        expect(journal.list().map((record) => record.summary)).toEqual(['two', 'one']);
        expect(journal.list({ module: 'M1' }).map((record) => record.summary)).toEqual(['one']);
        expect(journal.list({ limit: 1 }).map((record) => record.summary)).toEqual(['two']);
    });

    it('stores a copy of the action', async () => {
        const changes: JournalChange[] = [{ target: 'flag', ref: { name: 'a' }, before: { v: 1 }, after: { v: 2 } }];
        await journal.record(action({ changes }));
        (changes[0]!.after as { v: number }).v = 99;
        expect(journal.list()[0]!.changes[0]!.after).toEqual({ v: 2 });
    });

    it('undoes changes in reverse order and marks the record', async () => {
        const order: string[] = [];
        journal.registerUndo('flag', async (change) => {
            order.push(String(change.ref.name));
            return true;
        });
        const undone: JournalRecord[] = [];
        journal.onUndone((record) => undone.push(record));
        const id = await journal.record(
            action({
                changes: [
                    { target: 'flag', ref: { name: 'a' }, before: 0, after: 1 },
                    { target: 'flag', ref: { name: 'b' }, before: 0, after: 1 },
                ],
            }),
        );
        expect(await journal.undo(id)).toBe(true);
        expect(order).toEqual(['b', 'a']);
        expect(storedRecords()[0]?.undone).toBe(true);
        expect(undone.map((record) => record.id)).toEqual([id]);
        expect(await journal.undo(id)).toBe(false);
        expect(order).toEqual(['b', 'a']);
    });

    it('refuses to undo without a handler for every target', async () => {
        const handler = vi.fn(async () => true);
        journal.registerUndo('flag', handler);
        const id = await journal.record(
            action({
                changes: [
                    { target: 'flag', ref: {}, before: 0, after: 1 },
                    { target: 'lorebook-entry', ref: {}, before: 0, after: 1 },
                ],
            }),
        );
        expect(await journal.undo(id)).toBe(false);
        expect(handler).not.toHaveBeenCalled();
        expect(await journal.undo('missing')).toBe(false);
    });

    it('stops at a failing handler and keeps the record active', async () => {
        journal.registerUndo('ok', async () => true);
        journal.registerUndo('bad', async () => {
            throw new Error('locked');
        });
        const id = await journal.record(
            action({
                changes: [
                    { target: 'ok', ref: {}, before: 0, after: 1 },
                    { target: 'bad', ref: {}, before: 0, after: 1 },
                ],
            }),
        );
        expect(await journal.undo(id)).toBe(false);
        expect(storedRecords()[0]?.undone).toBeUndefined();
        journal.registerUndo('bad', async () => true);
        expect(await journal.undo(id)).toBe(true);
    });

    it('undoes every action of one message', async () => {
        const seen: unknown[] = [];
        journal.registerUndo('flag', async (change) => {
            seen.push(change.ref.n);
            return true;
        });
        await journal.record(
            action({ sourceMessage: 4, changes: [{ target: 'flag', ref: { n: 1 }, before: 0, after: 1 }] }),
        );
        await journal.record(
            action({ sourceMessage: 5, changes: [{ target: 'flag', ref: { n: 2 }, before: 0, after: 1 }] }),
        );
        await journal.record(
            action({ sourceMessage: 4, changes: [{ target: 'flag', ref: { n: 3 }, before: 0, after: 1 }] }),
        );
        expect(await journal.undoForMessage(4)).toBe(2);
        expect(seen).toEqual([3, 1]);
        expect(await journal.undoForMessage(4)).toBe(0);
    });

    it('keeps 30 days and at most maxRecords records', async () => {
        vi.useFakeTimers();
        const capped = createJournal({ host, chat, log: createTestLogger() }, { maxRecords: 3 });
        for (let i = 0; i < 5; i++) await capped.record(action({ summary: `n${i}` }));
        expect(storedRecords().map((record) => record.summary)).toEqual(['n2', 'n3', 'n4']);
        await vi.advanceTimersByTimeAsync(31 * 24 * 60 * 60_000);
        await capped.record(action({ summary: 'fresh' }));
        expect(storedRecords().map((record) => record.summary)).toEqual(['fresh']);
    });

    it('trims old records when a journal loads', async () => {
        const files = createFileStore(host, createTestLogger());
        const old: JournalRecord = { ...action(), id: 'old', at: Date.now() - 40 * 24 * 60 * 60_000, chatId: 'chat-1' };
        const recent: JournalRecord = { ...action(), id: 'recent', at: Date.now(), chatId: 'chat-1' };
        mock.files.set(
            chatDocName(files, 'chat-1', JOURNAL_KIND),
            JSON.stringify({ schema: 1, version: 1, updatedAt: 1, tabId: 'x', data: { records: [old, recent] } }),
        );
        await journal.load();
        await vi.waitFor(() => expect(storedRecords().map((record) => record.id)).toEqual(['recent']));
    });

    it('follows the open chat', async () => {
        await journal.record(action({ summary: 'first chat' }));
        const changed = vi.fn();
        journal.onChange(changed);
        await switchChat(mock, 'chat-2');
        expect(changed).toHaveBeenCalled();
        await vi.waitFor(() => expect(journal.list()).toEqual([]));
        await journal.record(action({ summary: 'second chat' }));
        expect(journal.list().map((record) => record.summary)).toEqual(['second chat']);
        expect(storedRecords('chat-1').map((record) => record.summary)).toEqual(['first chat']);

        await switchChat(mock, 'chat-1');
        await vi.waitFor(() => expect(journal.list().map((record) => record.summary)).toEqual(['first chat']));
    });

    it('lists lazily: the first call starts loading', async () => {
        await journal.record(action({ summary: 'stored' }));
        const fresh = createJournal({
            host,
            chat: createChatStore(host, createFileStore(host, createTestLogger()), createTestLogger()),
            log: createTestLogger(),
        });
        expect(fresh.list()).toEqual([]);
        await vi.waitFor(() => expect(fresh.list().map((record) => record.summary)).toEqual(['stored']));
    });

    it('keeps records without a chat in memory', async () => {
        mock.chatId = undefined;
        const id = await journal.record(action({ summary: 'loose' }));
        expect(journal.list().map((record) => record.id)).toEqual([id]);
        expect(mock.files.size).toBe(0);
        journal.registerUndo('flag', async () => true);
        expect(await journal.undo(id)).toBe(true);
        expect(journal.list()[0]?.undone).toBe(true);
    });

    it('retries when another tab wrote the journal first', async () => {
        await journal.record(action({ summary: 'mine' }));
        const otherChat = createChatStore(host, createFileStore(host, createTestLogger()), createTestLogger());
        const other = createJournal({ host, chat: otherChat, log: createTestLogger() });
        await other.record(action({ summary: 'theirs' }));
        await journal.record(action({ summary: 'mine again' }));
        expect(storedRecords().map((record) => record.summary)).toEqual(['mine', 'theirs', 'mine again']);
        otherChat.dispose();
    });
});
