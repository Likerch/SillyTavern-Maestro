import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutonomy } from '../../src/core/autonomy';
import type { AutonomyService } from '../../src/core/autonomy';
import { createChatStore } from '../../src/core/chat-store';
import type { MaestroChatStore } from '../../src/core/chat-store';
import { createFileStore } from '../../src/core/files';
import type { MaestroFileStore } from '../../src/core/files';
import { createJournal } from '../../src/core/journal';
import type { JournalService } from '../../src/core/journal';
import { Settings } from '../../src/core/settings';
import type { Inbox, Proposal } from '../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestI18n, createTestLogger, storedJson } from '../helpers/core-host';
import type { FakeUi, TestHost } from '../helpers/core-host';
import { installStMock } from '../helpers/st-mock';
import type { StMock } from '../helpers/st-mock';

let mock: StMock;
let host: TestHost;
let files: MaestroFileStore;
let chat: MaestroChatStore;
let journal: JournalService;
let settings: Settings;
let saves: number;
let ui: FakeUi;
let added: Proposal[];
let addOptions: unknown[];
let inbox: Inbox;
let autonomy: AutonomyService;

function proposal(overrides: Partial<Proposal<{ v: number }>> = {}): Proposal<{ v: number }> & { applied: number[] } {
    const applied: number[] = [];
    return {
        module: 'M8',
        kind: 'canon.fact',
        title: 'Anna has a sister',
        description: 'From message 3',
        changes: [{ target: 'flag', ref: { name: 'x' }, before: 0, after: 1 }],
        payload: { v: 1 },
        apply: async (payload) => {
            applied.push(payload.v);
        },
        ...overrides,
        applied,
    };
}

function make(withFiles = true): AutonomyService {
    const created = createAutonomy(
        { settings, journal, log: createTestLogger(), files: withFiles ? files : undefined },
        { saveDelayMs: 1_000 },
    );
    created.bind({ inbox, ui, i18n: createTestI18n('en') });
    return created;
}

beforeEach(() => {
    mock = installStMock();
    host = createTestHost(mock);
    files = createFileStore(host, createTestLogger());
    chat = createChatStore(host, files, createTestLogger(), { metadataSaveDelayMs: 0 });
    journal = createJournal({ host, chat, log: createTestLogger() });
    saves = 0;
    settings = new Settings(
        () => mock.extensionSettings,
        () => {
            saves++;
        },
        createTestLogger(),
    );
    ui = createFakeUi();
    added = [];
    addOptions = [];
    inbox = {
        registerApplier: () => () => {},
        add: async (item, options) => {
            added.push(item);
            addOptions.push(options);
            return `card-${added.length}`;
        },
        list: () => [],
        accept: async () => true,
        reject: async () => {},
        snooze: async () => {},
        invalidateMessage: async () => 0,
        onChange: () => () => {},
        count: () => 0,
    };
    autonomy = make();
});

afterEach(() => {
    autonomy.dispose();
    chat.dispose();
    vi.useRealTimers();
});

describe('levels', () => {
    it('uses the setting for the kind, otherwise the module default', () => {
        expect(autonomy.level('canon.fact', 'inbox')).toBe('inbox');
        settings.core().autonomy['canon.fact'] = 'notify';
        expect(autonomy.level('canon.fact', 'inbox')).toBe('notify');
    });

    it('never resolves a neverAuto kind to auto', () => {
        autonomy.neverAuto('lore.base');
        settings.core().autonomy['lore.base'] = 'auto';
        expect(autonomy.level('lore.base', 'ask')).toBe('ask');
        expect(autonomy.level('lore.base', 'auto')).toBe('ask');
    });

    it('sets a level for a kind, refusing auto for never-auto kinds', () => {
        autonomy.neverAuto('lore.base');
        expect(autonomy.isNeverAuto!('lore.base')).toBe(true);
        expect(autonomy.isNeverAuto!('canon.fact')).toBe(false);
        expect(autonomy.setLevel!('lore.base', 'auto')).toBe(false);
        expect(settings.core().autonomy['lore.base']).toBeUndefined();
        expect(autonomy.setLevel!('canon.fact', 'auto')).toBe(true);
        expect(autonomy.level('canon.fact', 'inbox')).toBe('auto');
    });
});

describe('decide', () => {
    it('off: skips', async () => {
        const item = proposal();
        expect(await autonomy.decide(item, 'off')).toBe('skipped');
        expect(item.applied).toEqual([]);
    });

    it('auto: applies and journals', async () => {
        const item = proposal({ sourceMessage: 3 });
        expect(await autonomy.decide(item, 'auto')).toBe('applied');
        expect(item.applied).toEqual([1]);
        expect(journal.list()[0]).toMatchObject({
            module: 'M8',
            kind: 'canon.fact',
            summary: 'Anna has a sister',
            sourceMessage: 3,
            changes: item.changes,
        });
    });

    it('auto: tells the user what it did, grouped per kind, with undo through the journal', async () => {
        let undone = 0;
        journal.registerUndo('flag', async () => {
            undone++;
            return true;
        });
        const item = proposal({ sourceMessage: 3 });
        await autonomy.decide(item, 'auto');
        const [notice] = ui.notices;
        expect(notice?.text).toBe('Done: Anna has a sister');
        expect(notice?.options).toMatchObject({ importance: 'info', group: 'autonomy.auto:canon.fact' });
        // Without a kind label the merged text does without it; with one it names the kind.
        expect(notice?.options?.groupText?.(3)).toBe('Made 3 changes myself');
        expect(notice?.options?.action?.label).toBe('Undo');
        notice?.options?.action?.run();
        await vi.waitFor(() => expect(undone).toBe(1));
        expect(journal.list()[0]?.undone).toBe(true);
        await vi.waitFor(() => expect(ui.notices.at(-1)?.text).toBe('Undone: Anna has a sister'));
    });

    it("auto: uses the proposal's own story words and the kind label in the merged notice", async () => {
        const i18n = createTestI18n('ru');
        i18n.register({ en: { 'kind.canon.fact': 'Facts' }, ru: { 'kind.canon.fact': 'Факты о мире' } });
        autonomy.bind({ inbox, ui, i18n });
        await autonomy.decide(proposal(), 'auto');
        expect(ui.notices[0]?.options?.groupText?.(2)).toBe('Сделал сам 2 изменения — Факты о мире');
        expect(ui.notices[0]?.options?.groupText?.(5)).toBe('Сделал сам 5 изменений — Факты о мире');
        const custom = proposal({
            appliedNotice: { text: 'Запомнил пробно: праздник урожая', group: 'living.captured', groupText: () => 'x' },
        });
        await autonomy.decide(custom, 'auto');
        expect(ui.notices[1]).toMatchObject({
            text: 'Запомнил пробно: праздник урожая',
            options: { group: 'living.captured', importance: 'info' },
        });
        // Other levels say nothing of the kind: the Inbox card and the badge are the message.
        await autonomy.decide(proposal(), 'inbox');
        expect(ui.notices).toHaveLength(2);
    });

    it("ask: shows the proposal's technical notes in the confirmation", async () => {
        await autonomy.decide(proposal({ details: 'Book: World, uid 4' }), 'ask');
        expect(ui.confirms.at(-1)).toMatchObject({ title: 'Anna has a sister', body: 'From message 3' });
        expect(ui.confirmOptions.at(-1)).toEqual({ details: 'Book: World, uid 4' });
    });

    it('auto: skips a proposal whose "before" changed', async () => {
        const item = proposal({ stillValid: async () => false });
        expect(await autonomy.decide(item, 'auto')).toBe('skipped');
        expect(item.applied).toEqual([]);
        expect(journal.list()).toEqual([]);
    });

    it('auto: reports a failing apply', async () => {
        const item = proposal({
            apply: async () => {
                throw new Error('boom');
            },
        });
        expect(await autonomy.decide(item, 'auto')).toBe('skipped');
        expect(ui.notices.at(-1)).toMatchObject({
            text: 'Could not apply: Anna has a sister',
            options: { level: 'error' },
        });
    });

    it('notify: shows a message badge that applies on click', async () => {
        const item = proposal({ sourceMessage: 7 });
        expect(await autonomy.decide(item, 'notify')).toBe('notified');
        expect(item.applied).toEqual([]);
        const badge = ui.badges[0]!;
        expect(badge.messageIndex).toBe(7);
        expect(badge.badge.text).toBe('Anna has a sister');
        expect(badge.badge.action?.label).toBe('Apply');
        badge.badge.action!.run();
        badge.badge.action!.run();
        await vi.waitFor(() => expect(item.applied).toEqual([1]));
        expect(badge.removed).toBe(true);
        await vi.waitFor(() => expect(journal.list()).toHaveLength(1));
        expect(autonomy.stats()).toEqual([expect.objectContaining({ kind: 'canon.fact', accepted: 1, streak: 1 })]);
    });

    it('notify: the line under the message is a proposal; «No, thanks» lets it go as a rejection', async () => {
        const item = proposal({ sourceMessage: 4 });
        await autonomy.decide(item, 'notify');
        const badge = ui.badges[0]!;
        expect(badge.badge).toMatchObject({ kind: 'proposal', text: 'Anna has a sister' });
        const dismiss = badge.badge.actions?.[0];
        expect(dismiss?.label).toBe('No, thanks');
        await dismiss!.run();
        badge.badge.action!.run();
        expect(badge.removed).toBe(true);
        await Promise.resolve();
        expect(item.applied).toEqual([]);
        expect(autonomy.stats()).toEqual([expect.objectContaining({ kind: 'canon.fact', rejected: 1, accepted: 0 })]);
    });

    it('notify: uses a notice when there is no source message', async () => {
        const item = proposal();
        expect(await autonomy.decide(item, 'notify')).toBe('notified');
        const notice = ui.notices[0]!;
        expect(notice.text).toBe('Anna has a sister');
        notice.options!.action!.run();
        await vi.waitFor(() => expect(item.applied).toEqual([1]));
    });

    it('notify: tells the user when the proposal went stale before the click', async () => {
        const item = proposal({ stillValid: async () => false });
        await autonomy.decide(item, 'notify');
        ui.notices[0]!.options!.action!.run();
        await vi.waitFor(() => expect(ui.notices).toHaveLength(2));
        expect(ui.notices[1]!.text).toMatch(/out of date/);
        expect(item.applied).toEqual([]);
    });

    it('inbox: queues a card', async () => {
        const item = proposal();
        expect(await autonomy.decide(item, 'inbox')).toBe('queued');
        expect(added).toEqual([item]);
        expect(addOptions).toEqual([undefined]);
    });

    it('inbox: the card lives as long as the proposal says (MAESTRO_API ttlMs)', async () => {
        await autonomy.decide(proposal({ ttlMs: 3_600_000 }), 'inbox');
        await autonomy.decide(proposal({ ttlMs: 0 }), 'inbox');
        expect(addOptions).toEqual([{ ttlMs: 3_600_000 }, undefined]);
    });

    it('ask: applies on yes, rejects on no', async () => {
        const yes = proposal();
        expect(await autonomy.decide(yes, 'ask')).toBe('applied');
        expect(ui.confirms[0]).toEqual({ title: 'Anna has a sister', body: 'From message 3' });
        expect(yes.applied).toEqual([1]);

        ui.confirmAnswer = false;
        const no = proposal();
        expect(await autonomy.decide(no, 'ask')).toBe('rejected');
        expect(no.applied).toEqual([]);
        expect(autonomy.stats()[0]).toMatchObject({ accepted: 1, rejected: 1, streak: 0 });
    });

    it('degrades to the inbox, then to skip, before bind()', async () => {
        const unbound = createAutonomy({ settings, journal, log: createTestLogger() });
        expect(await unbound.decide(proposal(), 'notify')).toBe('skipped');
        expect(await unbound.decide(proposal(), 'ask')).toBe('skipped');
        expect(await unbound.decide(proposal(), 'inbox')).toBe('skipped');
        expect(await unbound.decide(proposal(), 'auto')).toBe('applied');
        unbound.bind({ inbox, ui, i18n: createTestI18n() });
        expect(await unbound.decide(proposal(), 'notify')).toBe('notified');
    });
});

describe('stats and trust', () => {
    it('counts outcomes; anything but a clean accept breaks the streak', () => {
        autonomy.record('a', 'accepted');
        autonomy.record('a', 'accepted');
        autonomy.record('a', 'edited');
        autonomy.record('a', 'accepted');
        autonomy.record('a', 'rejected');
        autonomy.record('a', 'undone');
        autonomy.record('a', 'accepted');
        expect(autonomy.stats()).toEqual([{ kind: 'a', accepted: 4, edited: 1, rejected: 1, undone: 1, streak: 1 }]);
    });

    it('counts journal undos', async () => {
        journal.registerUndo('flag', async () => true);
        await autonomy.decide(proposal(), 'auto');
        await journal.undo(journal.list()[0]!.id);
        expect(autonomy.stats()[0]).toMatchObject({ kind: 'canon.fact', undone: 1 });
    });

    it('offers auto after 5 clean accepts in a row and switches on click', async () => {
        const paths: string[] = [];
        settings.onChange((path) => paths.push(path));
        await autonomy.decide(proposal(), 'inbox');
        for (let i = 0; i < 4; i++) autonomy.record('canon.fact', 'accepted');
        expect(ui.notices).toHaveLength(0);
        autonomy.record('canon.fact', 'accepted');
        expect(ui.notices).toHaveLength(1);
        const offer = ui.notices[0]!;
        expect(offer.text).toBe(
            'You have accepted “canon.fact” 5 times in a row without changes. Shall I do it myself from now on, without asking?',
        );
        expect(offer.options?.urgent).toBeUndefined();
        expect(offer.options?.importance).toBe('important');
        autonomy.record('canon.fact', 'accepted');
        expect(ui.notices).toHaveLength(1);

        offer.options!.action!.run();
        expect(settings.core().autonomy['canon.fact']).toBe('auto');
        expect(saves).toBeGreaterThan(0);
        expect(paths).toContain('core.autonomy.canon.fact');
        expect(autonomy.level('canon.fact', 'inbox')).toBe('auto');
    });

    it('uses a registered kind label in the offer', () => {
        const i18n = createTestI18n('ru');
        i18n.register({ en: { 'kind.canon.fact': 'Canon facts' }, ru: { 'kind.canon.fact': 'Факты канона' } });
        autonomy.bind({ inbox, ui, i18n });
        for (let i = 0; i < 5; i++) autonomy.record('canon.fact', 'accepted');
        expect(ui.notices[0]!.text).toBe(
            'Ты уже 5 раз подряд принимаешь «Факты канона» без правок. Делать это дальше самому, не спрашивая?',
        );
    });

    it('does not offer auto for neverAuto kinds or levels other than inbox/notify', async () => {
        autonomy.neverAuto('lore.base');
        for (let i = 0; i < 5; i++) autonomy.record('lore.base', 'accepted');
        await autonomy.decide(proposal({ kind: 'preset.edit' }), 'ask');
        for (let i = 0; i < 5; i++) autonomy.record('preset.edit', 'accepted');
        settings.core().autonomy['qc.swipe'] = 'auto';
        for (let i = 0; i < 5; i++) autonomy.record('qc.swipe', 'accepted');
        expect(ui.notices).toHaveLength(0);
    });

    it('persists stats in maestro-autonomy.json, merged with other tabs', async () => {
        vi.useFakeTimers();
        const local = make();
        await local.ready();
        local.record('a', 'accepted');
        local.record('a', 'accepted');
        await vi.advanceTimersByTimeAsync(999);
        expect(mock.files.has('maestro-autonomy.json')).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await local.flush();
        expect(storedJson(mock, 'maestro-autonomy.json')).toEqual({
            schema: 1,
            stats: { a: { accepted: 2, edited: 0, rejected: 0, undone: 0, streak: 2 } },
        });

        const otherTab = createAutonomy({
            settings,
            journal,
            log: createTestLogger(),
            files: createFileStore(host, createTestLogger()),
        });
        await otherTab.ready();
        expect(otherTab.stats()).toEqual([{ kind: 'a', accepted: 2, edited: 0, rejected: 0, undone: 0, streak: 2 }]);
        otherTab.record('a', 'accepted');
        await otherTab.flush();

        local.record('a', 'rejected');
        await local.flush();
        expect(storedJson(mock, 'maestro-autonomy.json')).toEqual({
            schema: 1,
            stats: { a: { accepted: 3, edited: 0, rejected: 1, undone: 0, streak: 0 } },
        });
        expect(local.stats()[0]).toMatchObject({ accepted: 3, rejected: 1, streak: 0 });
        local.dispose();
        otherTab.dispose();
    });

    it('keeps stats in memory without a file store', async () => {
        const memory = make(false);
        memory.record('a', 'accepted');
        await memory.flush();
        expect(mock.files.size).toBe(0);
        expect(memory.stats()).toHaveLength(1);
        memory.dispose();
    });
});
