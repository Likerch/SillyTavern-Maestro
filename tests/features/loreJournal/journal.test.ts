import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredJournal } from '../../../src/domain/lore-journal';
import { LORE_DOC_KIND, loreJournalModule } from '../../../src/features/loreJournal';
import type { LoreJournalApi, TurnLoreRecord } from '../../../src/features/loreJournal/api';
import { changeChat, createLoreApp, finishReply, settle, startGeneration } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';
import { finalList, scanPayloads, wiEntry } from '../../helpers/lore-fixtures';
import type { LoopSpec } from '../../helpers/lore-fixtures';
import { message } from '../../helpers/st-mock';

const anna = wiEntry('World', 1, {
    comment: 'Anna',
    key: ['Anna'],
    content: 'Anna lives in the Silver Tower.',
    extensions: { lorebook_localizer: { version: 1, languages: {} } },
});
const tower = wiEntry('World', 2, { comment: 'Tower', key: ['silver tower'], content: 'The tower is tall.' });
const rules = wiEntry('Core', 3, { comment: 'Rules', constant: true, content: 'Write well.' });
const huge = wiEntry('World', 4, { comment: 'Huge', key: ['tower'], content: 'x'.repeat(400) });

const LOOPS: LoopSpec[] = [
    { activated: [anna, rules], budget: 600 },
    { current: 2, activated: [tower], cut: [huge], budget: 600, overflowed: true },
];

async function scan(stand: LoreTestApp, loops: LoopSpec[] = LOOPS, final = true): Promise<void> {
    for (const payload of scanPayloads(loops)) await stand.emit('WORLDINFO_SCAN_DONE', payload);
    if (final) await stand.emit('WORLD_INFO_ACTIVATED', finalList(loops));
}

async function until(check: () => boolean, rounds = 400): Promise<void> {
    for (let i = 0; i < rounds && !check(); i++) await settle(5);
}

describe('M1 lore journal: capture', () => {
    let stand: LoreTestApp;
    let api: LoreJournalApi;
    let stop: () => Promise<void>;

    beforeEach(async () => {
        stand = createLoreApp();
        stand.mock.chat.push(
            message('Hi', { is_user: true, name: 'User' }),
            message('Hello', { name: 'Anna' }),
            message('Tell me about Anna', { is_user: true, name: 'User' }),
        );
        stand.adapters.bunnymo.core = ['Core'];
        const started = await stand.start(loreJournalModule);
        stop = started.stop;
        api = stand.app.modules.api<LoreJournalApi>('loreJournal')!;
    });

    afterEach(async () => {
        await stop();
    });

    it('records the lore of a real turn after the reply', async () => {
        const seen: TurnLoreRecord[] = [];
        api.onTurn((record) => seen.push(record));
        await startGeneration(stand);
        await scan(stand);
        expect(api.last()).toBeUndefined();
        stand.mock.chat.push(message('Anna smiles.', { name: 'Anna' }));
        await finishReply(stand, 3);
        await until(() => seen.length > 0);

        const record = api.last()!;
        expect(seen).toHaveLength(1);
        expect(record).toMatchObject({
            messageIndex: 3,
            generationType: 'normal',
            overflow: true,
            budgetTokens: 600,
            totalChars: [anna, rules, tower].reduce((sum, e) => sum + String(e.content).length, 0),
        });
        const byUid = Object.fromEntries(record.activations.map((row) => [row.uid, row]));
        expect(byUid[1]).toMatchObject({ loop: 1, recursionLevel: 0, tags: ['localizer'] });
        expect(byUid[3]).toMatchObject({ tags: ['bunnymo.core', 'constant'] });
        expect(byUid[2]).toMatchObject({ loop: 2, recursionLevel: 1, via: { world: 'World', uid: 1 } });
        expect(byUid[4]).toMatchObject({ cut: true, cutBy: 'budget', chars: 400 });
        // Tokens through ST's tokenizer (the mock counts chars / 4).
        expect(byUid[1]?.tokens).toBe(Math.ceil(String(anna.content).length / 4));
        expect(record.totalTokens).toBe(
            [anna, rules, tower].reduce((sum, e) => sum + Math.ceil(String(e.content).length / 4), 0),
        );

        const doc = stand.chat.doc<StoredJournal>('chat-1', LORE_DOC_KIND)!;
        expect(doc.records).toHaveLength(1);
        expect(doc.stats.turns).toBe(1);
        expect(api.turns()).toHaveLength(1);
        expect(api.turns(0)).toEqual([]);
        expect(api.lastContents?.().map((item) => item.uid)).toEqual([1, 3, 2]);
    });

    it('ignores dry runs, quiet generations and foreign scans', async () => {
        await stand.emit('GENERATION_STARTED', 'normal', {}, true);
        await scan(stand);
        await finishReply(stand, 3);
        expect(api.turns()).toHaveLength(0);

        await startGeneration(stand);
        await scan(stand, [{ activated: [anna] }]);
        // A quiet generation of another extension before the reply: its scan is not ours.
        await stand.emit('GENERATION_STARTED', 'quiet', {}, false);
        await scan(stand, [{ activated: [huge] }]);
        await stand.app.bus.emit('generation:before', { type: 'quiet', dryRun: false, quiet: true });
        await finishReply(stand, 3);
        await until(() => api.turns().length > 0);
        expect(api.last()?.activations.map((row) => row.uid)).toEqual([1]);

        // reply:ready without a generation records nothing.
        await finishReply(stand, 4);
        expect(api.turns()).toHaveLength(1);
    });

    it('falls back to the interceptor event when GENERATION_STARTED was missed', async () => {
        await stand.app.bus.emit('generation:before', { type: 'swipe', dryRun: false, quiet: false });
        await scan(stand, [{ activated: [anna] }], false);
        await finishReply(stand, 1, 'swipe');
        await until(() => api.turns().length > 0);
        expect(api.last()).toMatchObject({ messageIndex: 1, generationType: 'swipe' });
    });

    it('replaces the record of a swiped message and drops records of deleted messages', async () => {
        await startGeneration(stand);
        await scan(stand, [{ activated: [anna] }]);
        await finishReply(stand, 3);
        await until(() => api.turns().length === 1);
        await startGeneration(stand, 'swipe');
        await scan(stand, [{ activated: [tower] }]);
        await finishReply(stand, 3, 'swipe');
        await until(() => api.last()?.generationType === 'swipe');
        expect(api.turns().map((record) => record.activations[0]?.uid)).toEqual([2]);

        stand.mock.chat.splice(2);
        await stand.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'deleted' });
        await settle(20);
        expect(api.turns()).toHaveLength(0);
        expect(api.summary().turns).toBe(0);
    });

    it('records a turn without lore when ST had nothing to scan', async () => {
        await startGeneration(stand);
        // No SCAN_DONE: checkWorldInfo returns before the first loop when no entry exists.
        await finishReply(stand, 3);
        await until(() => api.turns().length > 0);
        expect(api.last()).toMatchObject({ messageIndex: 3, activations: [], totalChars: 0 });
        expect(api.summary().turns).toBe(1);
    });

    it('ignores impersonation and replies long after the generation ended', async () => {
        await startGeneration(stand, 'impersonate');
        await scan(stand, [{ activated: [anna] }]);
        await finishReply(stand, 3);
        expect(api.turns()).toEqual([]);

        await startGeneration(stand);
        await scan(stand, [{ activated: [anna] }]);
        await stand.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
        await finishReply(stand, 3);
        vi.restoreAllMocks();
        expect(api.turns()).toEqual([]);
    });

    it('marks entries cut by a Maestro rule', async () => {
        await startGeneration(stand);
        for (const payload of scanPayloads([{ activated: [anna, tower] }]))
            await stand.emit('WORLDINFO_SCAN_DONE', payload);
        api.markCut?.('World', 2);
        await stand.emit('WORLD_INFO_ACTIVATED', [anna]);
        await finishReply(stand, 3);
        await until(() => api.turns().length > 0);
        expect(api.last()?.activations.find((row) => row.uid === 2)).toMatchObject({ cut: true, cutBy: 'maestro' });
    });

    it('keeps journals per chat and reloads on chat switch', async () => {
        await startGeneration(stand);
        await scan(stand, [{ activated: [anna] }]);
        await finishReply(stand, 3);
        await until(() => api.turns().length > 0);
        await changeChat(stand, 'chat-2');
        expect(api.turns()).toEqual([]);
        expect(api.lastContents?.()).toEqual([]);
        await changeChat(stand, 'chat-1');
        expect(api.turns()).toHaveLength(1);
        await changeChat(stand, undefined);
        expect(api.turns()).toEqual([]);
        expect(api.summary().turns).toBe(0);
    });

    it('retries a save over a newer version from another tab', async () => {
        stand.chat.conflicts = 1;
        await startGeneration(stand);
        await scan(stand, [{ activated: [anna] }]);
        await finishReply(stand, 3);
        await until(() => stand.chat.puts.length > 0);
        expect(stand.chat.puts).toEqual([{ chatId: 'chat-1', kind: LORE_DOC_KIND }]);
    });

    it('summarises the chat with the catalog of the last scan', async () => {
        await stand.emit('WORLDINFO_ENTRIES_LOADED', {
            globalLore: [anna, tower, huge, wiEntry('World', 9, { content: 'off', disable: true })],
            characterLore: [],
            chatLore: [],
            personaLore: [rules],
        });
        await startGeneration(stand);
        await scan(stand, [{ activated: [anna, rules] }]);
        await finishReply(stand, 3);
        await until(() => api.turns().length > 0);
        const summary = api.summary();
        expect(summary.turns).toBe(1);
        expect(summary.neverActive.map((row) => row.uid)).toEqual([4, 2]);
        expect(summary.heaviestEntries.map((row) => row.uid)).toEqual([1, 3]);
        expect(api.summary()).toBe(summary);
    });

    it('releases every listener when stopped', async () => {
        await stop();
        for (const key of [
            'WORLDINFO_SCAN_DONE',
            'WORLDINFO_ENTRIES_LOADED',
            'WORLD_INFO_ACTIVATED',
            'GENERATION_STARTED',
        ]) {
            expect(stand.listenerCount(key), key).toBe(0);
        }
        expect(stand.tabs).toHaveLength(0);
        expect(stand.styles.size).toBe(0);
        expect(stand.app.modules.api('loreJournal')).toBeUndefined();
        stop = async () => {};
    });
});

describe('M1 lore journal: why a book is active', () => {
    it('lists reasons for every active book', async () => {
        const stand = createLoreApp();
        const { stop } = await stand.start(loreJournalModule);
        const api = stand.app.modules.api<LoreJournalApi>('loreJournal')!;
        for (const name of ['World', 'Anna', 'Card', 'Extra', 'Chat', 'Persona'])
            stand.books.set(name, { entries: {} });
        stand.worldInfo.selected_world_info = ['World', 'Anna', 'Deleted'];
        stand.worldInfo.world_info = { charLore: [{ name: 'anna', extraBooks: ['Extra'] }, 'junk'] };
        stand.ctx.characters = [{ name: 'Anna', avatar: 'anna.png', data: { extensions: { world: 'Card' } } }];
        stand.ctx.characterId = 0;
        stand.mock.chatMetadata.world_info = 'Chat';
        stand.mock.chatMetadata.carrot_chat_books = ['Chat'];
        (stand.ctx.powerUserSettings as Record<string, unknown>).persona_description_lorebook = 'Persona';
        stand.adapters.desPresent = true;
        stand.adapters.desSettings = { lorebook: { autoLinked: ['Anna'] } };
        expect(await api.whyActive()).toEqual([
            { book: 'Chat', reasons: ['chat', 'ckConnector'] },
            { book: 'Persona', reasons: ['persona'] },
            { book: 'Card', reasons: ['character'] },
            { book: 'Extra', reasons: ['characterExtra'] },
            { book: 'World', reasons: ['global'] },
            { book: 'Anna', reasons: ['global', 'desAutoLink'] },
        ]);

        // Group chat: every member's books.
        stand.ctx.groupId = 'g';
        stand.ctx.groups = [{ id: 'g', name: 'G', members: ['anna.png', 'ghost.png'] }];
        stand.books.clear();
        stand.worldInfo.selected_world_info = [];
        stand.mock.chatMetadata = {};
        stand.adapters.desPresent = false;
        expect(await api.whyActive()).toEqual([
            { book: 'Persona', reasons: ['persona'] },
            { book: 'Card', reasons: ['character'] },
            { book: 'Extra', reasons: ['characterExtra'] },
        ]);
        await stop();
    });
});
