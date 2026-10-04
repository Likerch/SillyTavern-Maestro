import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutonomy } from '../../src/core/autonomy';
import type { AutonomyService } from '../../src/core/autonomy';
import { createBus } from '../../src/core/bus';
import { chatDocName, createChatStore } from '../../src/core/chat-store';
import type { ChatEnvelope, MaestroChatStore } from '../../src/core/chat-store';
import { createFileStore } from '../../src/core/files';
import { createInbox, INBOX_KIND } from '../../src/core/inbox';
import type { InboxService, StoredCard } from '../../src/core/inbox';
import { createJournal } from '../../src/core/journal';
import type { JournalService } from '../../src/core/journal';
import { Settings } from '../../src/core/settings';
import type { Bus, Proposal } from '../../src/shared/contracts';
import { createTestHost, createTestLogger, storedJson, switchChat } from '../helpers/core-host';
import type { TestHost } from '../helpers/core-host';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

const DAY = 24 * 60 * 60_000;

let mock: StMock;
let host: TestHost;
let bus: Bus;
let chat: MaestroChatStore;
let journal: JournalService;
let autonomy: AutonomyService;
let inbox: InboxService;

function proposal(overrides: Partial<Proposal<{ v: number }>> = {}): Proposal<{ v: number }> & { applied: number[] } {
    const applied: number[] = [];
    return {
        module: 'M8',
        kind: 'canon.fact',
        title: 'Anna has a sister',
        changes: [{ target: 'flag', ref: { name: 'x' }, before: 0, after: 1 }],
        payload: { v: 1 },
        apply: async (payload) => {
            applied.push(payload.v);
        },
        ...overrides,
        applied,
    };
}

function storedCards(chatId = 'chat-1'): StoredCard[] {
    const files = createFileStore(host, createTestLogger());
    return (
        storedJson<ChatEnvelope<{ cards: StoredCard[] }>>(mock, chatDocName(files, chatId, INBOX_KIND))?.data.cards ??
        []
    );
}

function freshInbox(): InboxService {
    const store = createChatStore(host, createFileStore(host, createTestLogger()), createTestLogger());
    return createInbox({ chat: store, journal, autonomy, bus, log: createTestLogger() });
}

beforeEach(() => {
    mock = installStMock();
    host = createTestHost(mock);
    bus = createBus(createTestLogger());
    chat = createChatStore(host, createFileStore(host, createTestLogger()), createTestLogger(), {
        metadataSaveDelayMs: 0,
    });
    journal = createJournal({ host, chat, log: createTestLogger() });
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        createTestLogger(),
    );
    autonomy = createAutonomy({ settings, journal, log: createTestLogger() });
    inbox = createInbox({ chat, journal, autonomy, bus, log: createTestLogger() });
});

afterEach(() => {
    inbox.dispose();
    chat.dispose();
    vi.useRealTimers();
});

describe('inbox', () => {
    it('stores cards as JSON with a 14-day lifetime', async () => {
        const changed = vi.fn();
        inbox.onChange(changed);
        const before = Date.now();
        const id = await inbox.add(proposal({ sourceMessage: 2, description: 'why' }));
        const [card] = storedCards();
        expect(card).toMatchObject({
            id,
            module: 'M8',
            kind: 'canon.fact',
            title: 'Anna has a sister',
            description: 'why',
            payload: { v: 1 },
            sourceMessage: 2,
        });
        expect(card!.expiresAt! - card!.createdAt).toBe(14 * DAY);
        expect(card!.createdAt).toBeGreaterThanOrEqual(before);
        expect(inbox.list().map((item) => item.id)).toEqual([id]);
        expect(inbox.count()).toBe(1);
        expect(changed).toHaveBeenCalled();
    });

    it('accepts with the live proposal: apply, journal, autonomy stats', async () => {
        const item = proposal({ sourceMessage: 4 });
        const id = await inbox.add(item);
        expect(await inbox.accept(id)).toBe(true);
        expect(item.applied).toEqual([1]);
        expect(storedCards()).toEqual([]);
        expect(inbox.count()).toBe(0);
        expect(journal.list()[0]).toMatchObject({
            module: 'M8',
            kind: 'canon.fact',
            summary: 'Anna has a sister',
            sourceMessage: 4,
        });
        expect(autonomy.stats()[0]).toMatchObject({ kind: 'canon.fact', accepted: 1, streak: 1 });
    });

    it('counts an accept with edits as edited', async () => {
        const item = proposal();
        const id = await inbox.add(item);
        expect(await inbox.accept(id, { v: 5 })).toBe(true);
        expect(item.applied).toEqual([5]);
        expect(autonomy.stats()[0]).toMatchObject({ accepted: 0, edited: 1, streak: 0 });
    });

    it('after a reload applies through the registered applier', async () => {
        const id = await inbox.add(proposal());
        const reloaded = freshInbox();
        await reloaded.load();
        expect(reloaded.list().map((card) => card.id)).toEqual([id]);

        expect(await reloaded.accept(id)).toBe(false);
        expect(storedCards()).toHaveLength(1);

        const apply = vi.fn(async () => {});
        const off = reloaded.registerApplier('canon.fact', apply);
        expect(await reloaded.accept(id)).toBe(true);
        expect(apply).toHaveBeenCalledWith({ v: 1 });
        expect(storedCards()).toEqual([]);
        off();
        reloaded.dispose();
    });

    it('drops a card whose "before" no longer matches', async () => {
        const stale = proposal({ stillValid: async () => false });
        const first = await inbox.add(stale);
        expect(await inbox.accept(first)).toBe(false);
        expect(stale.applied).toEqual([]);
        expect(storedCards()).toEqual([]);

        const second = await inbox.add(proposal());
        const reloaded = freshInbox();
        const apply = vi.fn(async () => {});
        reloaded.registerApplier('canon.fact', apply, async (payload) => (payload as { v: number }).v === 2);
        expect(await reloaded.accept(second)).toBe(false);
        expect(apply).not.toHaveBeenCalled();
        expect(storedCards()).toEqual([]);
        reloaded.dispose();
    });

    it('keeps the card when apply fails', async () => {
        const id = await inbox.add(
            proposal({
                apply: async () => {
                    throw new Error('boom');
                },
            }),
        );
        expect(await inbox.accept(id)).toBe(false);
        expect(storedCards()).toHaveLength(1);
        expect(await inbox.accept('unknown')).toBe(false);
    });

    it('applies once on a double click', async () => {
        const item = proposal();
        const id = await inbox.add(item);
        const results = await Promise.all([inbox.accept(id), inbox.accept(id)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(item.applied).toEqual([1]);
    });

    it('rejects: removes the card and records the outcome', async () => {
        const id = await inbox.add(proposal());
        await inbox.reject(id);
        expect(storedCards()).toEqual([]);
        expect(autonomy.stats()[0]).toMatchObject({ rejected: 1 });
        await inbox.reject(id);
        expect(autonomy.stats()[0]).toMatchObject({ rejected: 1 });
    });

    it('hides snoozed cards until the time passes', async () => {
        vi.useFakeTimers();
        const id = await inbox.add(proposal(), { ttlMs: 1_000 });
        await inbox.snooze(id, 2 * DAY);
        expect(inbox.list()).toEqual([]);
        expect(storedCards()[0]!.expiresAt).toBeGreaterThan(Date.now() + 2 * DAY);
        vi.setSystemTime(Date.now() + 2 * DAY + 1);
        expect(inbox.list().map((card) => card.id)).toEqual([id]);
    });

    it('expires cards and prunes them on load', async () => {
        vi.useFakeTimers();
        await inbox.add(proposal(), { ttlMs: 1_000 });
        const keep = await inbox.add(proposal());
        vi.setSystemTime(Date.now() + 2_000);
        expect(inbox.list().map((card) => card.id)).toEqual([keep]);
        const reloaded = freshInbox();
        await reloaded.load();
        await vi.waitFor(() => expect(storedCards().map((card) => card.id)).toEqual([keep]));
        reloaded.dispose();
    });

    it('caps the inbox by dropping the oldest non-deferred cards', async () => {
        const capped = createInbox({ chat, journal, autonomy, bus, log: createTestLogger() }, { cap: 3 });
        const deferred = await capped.add(proposal({ title: 'deferred' }), { deferred: true });
        const a = await capped.add(proposal({ title: 'a' }));
        const b = await capped.add(proposal({ title: 'b' }));
        const c = await capped.add(proposal({ title: 'c' }));
        expect(storedCards().map((card) => card.id)).toEqual([deferred, b, c]);
        expect(await capped.accept(a)).toBe(false);
        expect(capped.count()).toBe(2);
        expect(capped.list()).toHaveLength(3);
        capped.dispose();
    });

    it('drops cards of an invalidated message (also from the bus)', async () => {
        await inbox.add(proposal({ sourceMessage: 3 }));
        await inbox.add(proposal({ sourceMessage: 3 }));
        const other = await inbox.add(proposal({ sourceMessage: 4 }));
        expect(await inbox.invalidateMessage(3)).toBe(2);
        expect(await inbox.invalidateMessage(3)).toBe(0);
        await bus.emit('message:invalidated', { messageIndex: 4, reason: 'swiped' });
        await vi.waitFor(() => expect(storedCards()).toEqual([]));
        expect(await inbox.accept(other)).toBe(false);
    });

    it('follows the open chat', async () => {
        const first = await inbox.add(proposal());
        await switchChat(mock, 'chat-2');
        await bus.emit('chat:changed', { chatId: 'chat-2' });
        expect(inbox.list()).toEqual([]);
        await inbox.load();
        expect(inbox.list()).toEqual([]);
        const second = await inbox.add(proposal());
        expect(storedCards('chat-2').map((card) => card.id)).toEqual([second]);
        expect(storedCards('chat-1').map((card) => card.id)).toEqual([first]);

        await switchChat(mock, 'chat-1');
        await bus.emit('chat:changed', { chatId: 'chat-1' });
        await inbox.load();
        expect(inbox.list().map((card) => card.id)).toEqual([first]);
    });

    it('stops listening to the bus after dispose', async () => {
        await inbox.add(proposal({ sourceMessage: 1 }));
        inbox.dispose();
        await bus.emit('message:invalidated', { messageIndex: 1, reason: 'deleted' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(storedCards()).toHaveLength(1);
    });
});
